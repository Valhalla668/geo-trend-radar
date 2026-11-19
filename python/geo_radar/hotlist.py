"""Public hot-list collection.

The data source is the same ``newsnow`` API that TrendRadar reads through
``platforms.api_url``, so this package reports the same hot lists without a
TrendRadar deployment. Platform ids and expected domains mirror TrendRadar's
``config/config.yaml``.

The endpoint rejects bot user agents, so a browser UA is sent and platforms are
fetched sequentially with a delay; failures are reported per platform instead of
being retried in a loop.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Iterable
from urllib.parse import parse_qsl, quote, urlencode, urlparse, urlunparse

DEFAULT_API_URL = "https://newsnow.busiyi.world/api/s"

SOURCE_CATALOG: list[dict[str, str]] = [
    {"id": "toutiao", "name": "今日头条", "expectedDomain": "toutiao.com"},
    {"id": "baidu", "name": "百度热搜", "expectedDomain": "baidu.com"},
    {"id": "wallstreetcn-hot", "name": "华尔街见闻", "expectedDomain": "wallstreetcn.com"},
    {"id": "thepaper", "name": "澎湃新闻", "expectedDomain": "thepaper.cn"},
    {"id": "bilibili-hot-search", "name": "bilibili 热搜", "expectedDomain": "bilibili.com"},
    {"id": "cls-hot", "name": "财联社热门", "expectedDomain": "cls.cn"},
    {"id": "ifeng", "name": "凤凰网", "expectedDomain": "ifeng.com"},
    {"id": "tieba", "name": "贴吧", "expectedDomain": "baidu.com"},
    {"id": "weibo", "name": "微博", "expectedDomain": "weibo.com"},
    {"id": "douyin", "name": "抖音", "expectedDomain": "douyin.com"},
    {"id": "zhihu", "name": "知乎", "expectedDomain": "zhihu.com"},
]

DEFAULT_PLATFORMS = ["zhihu", "weibo", "douyin", "baidu", "toutiao", "bilibili-hot-search"]

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

_DROP_PARAMS = {
    "band_rank", "refer", "t", "c", "s", "from", "spm",
    "share_token", "timestamp", "traceid",
}


def platform_info(platform_id: str) -> dict[str, str]:
    for entry in SOURCE_CATALOG:
        if entry["id"] == platform_id:
            return entry
    return {"id": platform_id, "name": platform_id, "expectedDomain": ""}


def platform_url(api_url: str, platform_id: str) -> str:
    base = api_url.strip() if isinstance(api_url, str) and api_url.strip() else DEFAULT_API_URL
    separator = "&" if "?" in base else "?"
    return f"{base}{separator}id={quote(platform_id)}"


def describe_http_failure(status: int, text: str) -> str:
    """Turn an upstream error body into one readable line."""
    detail = str(text or "")
    try:
        parsed = json.loads(detail)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        parts = [parsed.get("statusMessage"), parsed.get("message")]
        joined = " · ".join(part for part in parts if isinstance(part, str) and part)
        if joined:
            detail = joined
    cleaned = " ".join(detail.split())
    shortened = cleaned[:96] + "…" if len(cleaned) > 96 else cleaned
    return f"HTTP {status}" + (f" · {shortened}" if shortened else "")


def request_json(url: str, *, ua: str = DEFAULT_UA, timeout: float = 15.0) -> Any:
    """GET and decode JSON using only the standard library."""
    request = urllib.request.Request(
        url,
        headers={
            "user-agent": ua,
            "accept": "application/json",
            "accept-encoding": "identity",
            "accept-language": "zh-CN,zh;q=0.9",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8", errors="replace")
            status = getattr(response, "status", 200)
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(describe_http_failure(error.code, body)) from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"请求失败：{error.reason}") from error
    except TimeoutError as error:  # pragma: no cover - socket level
        raise RuntimeError(f"请求超时（{int(timeout * 1000)}ms）") from error
    if status < 200 or status >= 300:  # pragma: no cover - urlopen raises instead
        raise RuntimeError(describe_http_failure(status, body))
    try:
        return json.loads(body)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"返回内容不是 JSON：{body[:120]}") from error


def canonical_url(value: Any) -> str:
    """Drop tracking parameters so the same story on two runs dedupes."""
    if not isinstance(value, str) or not value:
        return ""
    try:
        parsed = urlparse(value)
    except ValueError:
        return value.strip().lower()
    query = [(key, item) for key, item in parse_qsl(parsed.query, keep_blank_values=True)
             if key.lower() not in _DROP_PARAMS]
    rebuilt = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, urlencode(query), ""))
    return rebuilt.lower()


def domain_allowed(url: Any, expected_domain: str | None) -> bool:
    """Accept a link only when it matches the platform's expected domain."""
    if not expected_domain:
        return True
    if not isinstance(url, str) or not url:
        return True
    try:
        host = urlparse(url).hostname or ""
    except ValueError:
        return False
    host = host.lower()
    wanted = expected_domain.lower()
    return host == wanted or host.endswith("." + wanted)


def normalize_item(raw: Any, platform_id: str, rank: int) -> dict[str, Any]:
    """Normalize one raw newsnow item into the shared shape."""
    item = raw if isinstance(raw, dict) else {}
    extra = item.get("extra") if isinstance(item.get("extra"), dict) else {}
    url = item.get("url") if isinstance(item.get("url"), str) and item.get("url") else ""
    if not url:
        mobile = item.get("mobileUrl")
        url = mobile if isinstance(mobile, str) else ""
    return {
        "platform": platform_id,
        "platformName": platform_info(platform_id)["name"],
        "rank": item.get("rank") if isinstance(item.get("rank"), int) else rank,
        "title": str(item.get("title") or "").strip(),
        "url": url,
        "hot": extra.get("info") if isinstance(extra.get("info"), str) else "",
        "summary": extra.get("hover") if isinstance(extra.get("hover"), str) else "",
        "id": "" if item.get("id") is None else str(item.get("id")),
    }


def collect_hotlists(
    *,
    platforms: Iterable[str] = DEFAULT_PLATFORMS,
    api_url: str = DEFAULT_API_URL,
    interval_ms: int = 600,
    timeout_ms: int = 15000,
    ua: str = DEFAULT_UA,
    fetcher: Callable[..., Any] | None = None,
    now: Callable[[], Any] | None = None,
) -> dict[str, Any]:
    """Collect hot lists for the given platforms."""
    from .store import iso_now

    if fetcher is None:
        def fetcher(url: str) -> Any:  # type: ignore[misc]
            return request_json(url, ua=ua, timeout=timeout_ms / 1000)

    fetch = fetcher
    items: list[dict[str, Any]] = []
    platform_reports: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    seen: set[str] = set()

    for index, platform_id in enumerate(list(platforms)):
        info = platform_info(platform_id)
        if index > 0 and interval_ms > 0:
            time.sleep(interval_ms / 1000)
        try:
            payload = fetch(platform_url(api_url, platform_id))
            raw_items = payload.get("items") if isinstance(payload, dict) else None
            raw_items = raw_items if isinstance(raw_items, list) else []
            accepted = 0
            rejected = 0
            for offset, raw in enumerate(raw_items):
                item = normalize_item(raw, platform_id, offset + 1)
                if not item["title"]:
                    continue
                if not domain_allowed(item["url"], info.get("expectedDomain")):
                    rejected += 1
                    continue
                key = canonical_url(item["url"]) or f"{platform_id}:{item['title']}"
                if key in seen:
                    continue
                seen.add(key)
                items.append(item)
                accepted += 1
            platform_reports.append({
                "id": platform_id,
                "name": info["name"],
                "status": payload.get("status") if isinstance(payload, dict) and isinstance(payload.get("status"), str) else "ok",
                "updatedTime": payload.get("updatedTime") if isinstance(payload, dict) and isinstance(payload.get("updatedTime"), (int, float)) else None,
                "accepted": accepted,
                "rejected": rejected,
            })
        except Exception as error:  # noqa: BLE001 - one platform must not stop the batch
            message = str(error)
            errors.append({"platform": platform_id, "name": info["name"], "message": message})
            platform_reports.append({"id": platform_id, "name": info["name"], "status": "error", "accepted": 0, "rejected": 0, "message": message})

    moment = now() if now is not None else None
    return {
        "items": items,
        "platforms": platform_reports,
        "errors": errors,
        "fetchedAt": iso_now(moment),
        "apiUrl": api_url or DEFAULT_API_URL,
    }
