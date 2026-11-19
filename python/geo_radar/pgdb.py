"""Read access to the two external PostgreSQL reference databases.

The package does not own the evidence or the product master data: those live in
tables the team already runs, reached over a normal database port. This module
owns only the connection, the identifier mapping and the read-only guarantee.

``psycopg`` is imported lazily, so a missing driver degrades to one clear message
instead of breaking the rest of the package.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from .envfile import default_password_variable, read_env_file, resolve_password

DEFAULT_MAPPING: dict[str, Any] = {
    "evidence": {
        "tables": {"claim": "geo_claim", "evidence": "geo_evidence"},
        "columns": {
            "claim": {
                "claim_id": "claim_id",
                "sku_code": "sku_code",
                "claim_text": "claim_text",
                "limitations": "limitations",
                "status": "status",
                "approved_at": "approved_at",
            },
            "evidence": {
                "evidence_id": "evidence_id",
                "claim_id": "claim_id",
                "grade": "grade",
                "source": "source",
                "source_url": "source_url",
                "tested_at": "tested_at",
                "valid_until": "valid_until",
                "sample_size": "sample_size",
                "method": "method",
            },
        },
    },
    "product": {
        "tables": {"sku": "geo_sku"},
        "columns": {
            "sku": {
                "sku_code": "sku_code",
                "product_name": "product_name",
                "brand": "brand",
                "category": "category",
                "spec": "spec",
                "price_cny": "price_cny",
                "price_updated": "price_updated",
                "shelf": "shelf",
                "skin_types": "skin_types",
                "filing_no": "filing_no",
                "launched_at": "launched_at",
                "status": "status",
            },
        },
    },
}

_DRIVER_HINT = "psycopg 未安装：在项目目录执行 `pip install psycopg[binary]` 后再试。"


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _non_empty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def quote_ident(value: Any) -> str:
    """Quote an identifier so a reserved word or odd spelling still works."""
    return '"' + str(value).replace('"', '""') + '"'


def _qualified(schema: str, table: str) -> str:
    return f"{quote_ident(schema)}.{quote_ident(table)}" if _non_empty(schema) else quote_ident(table)


def _merge_mapping(base: dict[str, Any], override: Any) -> dict[str, Any]:
    if not _is_object(override):
        return base
    merged: dict[str, Any] = {"tables": dict(base["tables"]), "columns": {}}
    for group, columns in base["columns"].items():
        extra = (override.get("columns") or {}).get(group) if _is_object(override.get("columns")) else None
        merged["columns"][group] = {**columns, **(extra if _is_object(extra) else {})}
    if _is_object(override.get("tables")):
        merged["tables"] = {**base["tables"], **override["tables"]}
    return merged


def normalize_instance(label: str, raw: Any, *, env: dict[str, str] | None = None, env_file: str | Path | None = None) -> tuple[dict[str, Any] | None, list[str]]:
    """Normalize one configured instance; the password resolves from env or ``.env``."""
    if not _is_object(raw):
        return None, [f"{label}：未配置连接"]
    if raw.get("enabled") is False:
        return None, [f"{label}：已禁用（enabled: false）"]
    problems: list[str] = []
    for key in ("host", "database", "user"):
        if not _non_empty(raw.get(key)):
            problems.append(f"{label}：缺少 {key}")
    try:
        port = int(raw.get("port") or 5432)
    except (TypeError, ValueError):
        port = -1
    if port <= 0 or port > 65535:
        problems.append(f"{label}：port 非法（{raw.get('port')}）")
    if problems:
        return None, problems

    credential = resolve_password(raw, label, env=env, env_file=env_file)
    defaults = DEFAULT_MAPPING.get(label)
    ssl_value = raw.get("ssl")
    if ssl_value is True:
        ssl_mode = "require"
    elif isinstance(ssl_value, dict):
        ssl_mode = str(ssl_value.get("sslmode") or "require")
    else:
        ssl_mode = "disable"

    instance = {
        "label": label,
        "host": str(raw["host"]).strip(),
        "port": port,
        "database": str(raw["database"]).strip(),
        "user": str(raw["user"]).strip(),
        "password": credential["value"],
        "passwordSource": credential["source"],
        "passwordVariable": credential["variable"],
        "passwordWarning": credential["warning"],
        "sslmode": ssl_mode,
        "schema": str(raw["schema"]).strip() if _non_empty(raw.get("schema")) else "",
        "connectTimeoutMs": max(500, int(raw.get("connectTimeoutMs") or 5000)),
        "statementTimeoutMs": max(500, int(raw.get("statementTimeoutMs") or 8000)),
        "maxRows": min(2000, max(1, int(raw.get("maxRows") or 200))),
        "mapping": None if defaults is None else _merge_mapping(defaults, raw.get("mapping")),
        "sql": raw.get("sql") if _is_object(raw.get("sql")) else {},
    }
    return instance, []


def resolve_env_file_path(config: dict[str, Any] | None = None, data_root: Path | str = "", plugin_root: Path | str = "") -> Path | None:
    """Where the credentials file lives.

    Order: ``config.envFile`` (absolute, or relative to the data directory), then
    ``<dataDir>/.env``, then ``<pluginRoot>/.env``.
    """
    config = config if isinstance(config, dict) else {}
    configured = config.get("envFile").strip() if isinstance(config.get("envFile"), str) else ""
    if configured:
        path = Path(configured)
        return path if path.is_absolute() else Path(data_root or ".") / path
    candidates: list[Path] = []
    if data_root:
        candidates.append(Path(data_root) / ".env")
    if plugin_root:
        candidates.append(Path(plugin_root) / ".env")
    for candidate in candidates:
        if read_env_file(candidate)["exists"]:
            return candidate
    return candidates[0] if candidates else None


def resolve_databases(
    config: dict[str, Any] | None = None,
    *,
    env: dict[str, str] | None = None,
    env_file: str | Path | None = None,
) -> dict[str, Any]:
    """Resolve both instances from the plugin-style config."""
    config = config if isinstance(config, dict) else {}
    root = config.get("databases") if _is_object(config.get("databases")) else {}
    evidence, evidence_problems = normalize_instance("evidence", root.get("evidence"), env=env, env_file=env_file)
    product, product_problems = normalize_instance("product", root.get("product"), env=env, env_file=env_file)
    return {
        "evidence": evidence,
        "product": product,
        "problems": [f"databases.{text}" for text in [*evidence_problems, *product_problems]],
        "configured": evidence is not None or product is not None,
        "envFile": None if env_file is None else str(env_file),
        "envFileExists": False if env_file is None else read_env_file(env_file)["exists"],
    }


def describe_instance(instance: dict[str, Any] | None) -> dict[str, Any] | None:
    """A status view that never leaks the password."""
    if instance is None:
        return None
    return {
        "label": instance["label"],
        "target": f"{instance['host']}:{instance['port']}/{instance['database']}",
        "user": instance["user"],
        "ssl": instance["sslmode"] != "disable",
        "schema": instance["schema"] or "public",
        "tables": {} if instance["mapping"] is None else instance["mapping"]["tables"],
        "passwordSet": bool(instance["password"]),
        "passwordSource": instance["passwordSource"],
        "passwordVariable": instance["passwordVariable"] or default_password_variable(instance["label"]),
        "passwordWarning": instance["passwordWarning"],
        "readOnly": True,
        "connectTimeoutMs": instance["connectTimeoutMs"],
        "statementTimeoutMs": instance["statementTimeoutMs"],
        "maxRows": instance["maxRows"],
        "customSql": list(instance["sql"].keys()),
    }


def build_claims_query(instance: dict[str, Any], params: dict[str, Any] | None = None) -> tuple[str, list[Any]]:
    """Generated claim+evidence query. ``$1`` sku, ``$2`` keyword, ``$3`` limit."""
    params = params or {}
    limit = min(instance["maxRows"], max(1, int(params.get("limit") or 50)))
    custom = instance["sql"].get("claims")
    if _non_empty(custom):
        return custom, [params.get("sku"), params.get("keyword"), limit]
    tables = instance["mapping"]["tables"]
    columns = instance["mapping"]["columns"]
    claim = columns["claim"]
    evidence = columns["evidence"]
    claim_table = _qualified(instance["schema"], tables["claim"])
    evidence_table = _qualified(instance["schema"], tables["evidence"])
    text = "\n".join([
        "select",
        f"  c.{quote_ident(claim['claim_id'])} as claim_id,",
        f"  c.{quote_ident(claim['sku_code'])} as sku_code,",
        f"  c.{quote_ident(claim['claim_text'])} as claim_text,",
        f"  c.{quote_ident(claim['limitations'])} as limitations,",
        f"  c.{quote_ident(claim['status'])} as status,",
        f"  c.{quote_ident(claim['approved_at'])} as approved_at,",
        f"  e.{quote_ident(evidence['evidence_id'])} as evidence_id,",
        f"  e.{quote_ident(evidence['grade'])} as grade,",
        f"  e.{quote_ident(evidence['source'])} as source,",
        f"  e.{quote_ident(evidence['source_url'])} as source_url,",
        f"  e.{quote_ident(evidence['tested_at'])} as tested_at,",
        f"  e.{quote_ident(evidence['valid_until'])} as valid_until,",
        f"  e.{quote_ident(evidence['sample_size'])} as sample_size,",
        f"  e.{quote_ident(evidence['method'])} as method",
        f"from {claim_table} c",
        f"left join {evidence_table} e on e.{quote_ident(evidence['claim_id'])} = c.{quote_ident(claim['claim_id'])}",
        f"where ($1::text is null or c.{quote_ident(claim['sku_code'])} = $1::text)",
        f"  and ($2::text is null or c.{quote_ident(claim['claim_text'])} ilike '%' || $2::text || '%')",
        f"  and coalesce(c.{quote_ident(claim['status'])}, 'approved') not in ('rejected', 'archived')",
        f"order by c.{quote_ident(claim['claim_id'])}, e.{quote_ident(evidence['grade'])} nulls last",
        "limit $3::int",
    ])
    return text, [params.get("sku"), params.get("keyword"), limit]


def build_sku_query(instance: dict[str, Any], params: dict[str, Any] | None = None) -> tuple[str, list[Any]]:
    """Generated SKU query. ``$1`` sku, ``$2`` keyword, ``$3`` limit."""
    params = params or {}
    limit = min(instance["maxRows"], max(1, int(params.get("limit") or 50)))
    custom = instance["sql"].get("sku")
    if _non_empty(custom):
        return custom, [params.get("sku"), params.get("keyword"), limit]
    tables = instance["mapping"]["tables"]
    columns = instance["mapping"]["columns"]["sku"]
    table = _qualified(instance["schema"], tables["sku"])
    names = list(columns.keys())
    select_lines = [
        f"  {quote_ident(columns[name])} as {quote_ident(name)}{'' if index == len(names) - 1 else ','}"
        for index, name in enumerate(names)
    ]
    text = "\n".join([
        "select",
        *select_lines,
        f"from {table}",
        f"where ($1::text is null or {quote_ident(columns['sku_code'])} = $1::text)",
        f"  and ($2::text is null or {quote_ident(columns['product_name'])} ilike '%' || $2::text || '%')",
        "limit $3::int",
    ])
    return text, [params.get("sku"), params.get("keyword"), limit]


_ERROR_HINTS = {
    "28P01": "认证失败：检查 user / password",
    "28000": "认证被拒：确认 pg_hba.conf 允许该来源",
    "3D000": "数据库不存在：检查 database",
    "42P01": "表不存在：检查 databases.*.mapping.tables 与 schema",
    "42703": "列不存在：检查 databases.*.mapping.columns",
    "42501": "权限不足：确认只读账号对该表有 select 权限",
    "57014": "语句超时：收紧查询或提高 statementTimeoutMs",
}


def describe_db_error(error: BaseException, instance: dict[str, Any] | None) -> str:
    """Turn a driver failure into one actionable line."""
    target = "未配置" if instance is None else f"{instance['host']}:{instance['port']}"
    code = getattr(error, "sqlstate", None) or ""
    message = " ".join(str(error).split())
    suffix = f"（{code}）" if code else ""
    hint = _ERROR_HINTS.get(str(code), "")
    lowered = message.lower()
    if not hint and ("connection refused" in lowered or "could not connect" in lowered):
        hint = "端口未监听：确认库已启动、端口对当前机器开放"
    elif not hint and "timeout" in lowered:
        hint = "连接超时：检查防火墙、安全组或 VPN"
    elif not hint and ("could not translate host name" in lowered or "name or service not known" in lowered):
        hint = "主机名解析失败：检查 host 拼写"
    if code in ("28P01", "28000") and instance is not None and not instance["password"]:
        hint = f"未提供口令：在 .env 或环境变量中设置 {instance['passwordVariable'] or default_password_variable(instance['label'])}"
    return f"连接 {target} 失败{suffix}：{message}" + (f"　→ {hint}" if hint else "")


class _Cursor:
    """Small wrapper so callers can run one statement and get dict rows."""

    def __init__(self, connection: Any) -> None:
        self._connection = connection

    def execute(self, text: str, params: Iterable[Any] | None = None) -> list[dict[str, Any]]:
        from psycopg.rows import dict_row

        with self._connection.cursor(row_factory=dict_row) as cursor:
            cursor.execute(text, list(params or []))
            if cursor.description is None:
                return []
            return list(cursor.fetchall())


def with_client(instance: dict[str, Any], callback: Any) -> Any:
    """Open a client, force a read-only session, run one callback, always close."""
    try:
        import psycopg
    except ModuleNotFoundError as error:  # pragma: no cover - depends on environment
        raise RuntimeError(_DRIVER_HINT) from error

    kwargs = {
        "host": instance["host"],
        "port": instance["port"],
        "dbname": instance["database"],
        "user": instance["user"],
        "password": instance["password"] or None,
        "sslmode": instance["sslmode"],
        "connect_timeout": max(1, instance["connectTimeoutMs"] // 1000),
        "options": f"-c statement_timeout={instance['statementTimeoutMs']}",
        "application_name": "geo-radar-py",
    }
    with psycopg.connect(**kwargs) as connection:  # pragma: no cover - needs a server
        with connection.cursor() as cursor:
            cursor.execute("set session characteristics as transaction read only")
            connection.commit()
        return callback(_Cursor(connection))


def test_connection(instance: dict[str, Any]) -> dict[str, Any]:
    """``select 1`` plus server version, for the readiness check."""
    def run(cursor: _Cursor) -> dict[str, Any]:
        rows = cursor.execute("select 1 as ok, current_database() as db, current_user as usr, version() as version")
        row = rows[0] if rows else {}
        return {
            "ok": row.get("ok") == 1,
            "database": row.get("db"),
            "user": row.get("usr"),
            "version": str(row.get("version") or "").split(" on ")[0],
        }

    return with_client(instance, run)


def introspect_schema(instance: dict[str, Any], wanted_tables: Iterable[str] = ()) -> dict[str, Any]:
    """List tables and columns so an existing schema can be mapped without hand-copying."""
    schema = instance["schema"] or "public"
    wanted = [table for table in wanted_tables if table]

    def run(cursor: _Cursor) -> dict[str, Any]:
        tables = cursor.execute(
            "select table_schema, table_name, table_type from information_schema.tables "
            "where table_schema = %s::text order by table_name",
            [schema],
        )
        names = [row["table_name"] for row in tables]
        selected = names if not wanted else [name for name in names if name in wanted]
        columns = cursor.execute(
            "select table_name, ordinal_position, column_name, data_type, is_nullable "
            "from information_schema.columns where table_schema = %s::text and table_name = any(%s::text[]) "
            "order by table_name, ordinal_position",
            [schema, selected],
        ) if selected else []
        return {
            "schema": schema,
            "tables": names,
            "selected": selected,
            "columns": [
                {
                    "table": row["table_name"],
                    "position": row["ordinal_position"],
                    "column": row["column_name"],
                    "type": row["data_type"],
                    "nullable": row["is_nullable"] == "YES",
                }
                for row in columns
            ],
        }

    return with_client(instance, run)


def config_template() -> str:
    """The YAML block a user can paste into the plugin config."""
    return """# 连接信息写在插件 config；口令不要写在这里，见 .env（db env）
databases:
  evidence:
    enabled: true
    host: 10.0.0.10
    port: 5432
    database: geo_evidence
    user: geo_readonly
    # 口令来源：默认读 GEO_EVIDENCE_PASSWORD（环境变量优先，其次 .env）
    passwordEnv: GEO_EVIDENCE_PASSWORD
    ssl: false
    schema: public
    connectTimeoutMs: 5000
    statementTimeoutMs: 8000
    maxRows: 200
    # 表名与字段名全部可配
    mapping:
      tables:
        claim: geo_claim
        evidence: geo_evidence
      columns:
        claim:
          claim_id: claim_id
          sku_code: sku_code
          claim_text: claim_text
          limitations: limitations
          status: status
          approved_at: approved_at
        evidence:
          evidence_id: evidence_id
          claim_id: claim_id
          grade: grade
          source: source
          source_url: source_url
          tested_at: tested_at
          valid_until: valid_until
          sample_size: sample_size
          method: method
  product:
    enabled: true
    host: 10.0.0.11
    port: 5432
    database: geo_product
    user: geo_readonly
    passwordEnv: GEO_PRODUCT_PASSWORD
    ssl: false
    schema: public
    mapping:
      tables:
        sku: geo_sku
"""
