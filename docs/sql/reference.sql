-- 仅作字段映射参考，不必照建。
-- 你们已有表时，只需把真实表名/字段名填进插件 config 的 databases.*.mapping，
-- 或先用 geo_db action=schema 导出真实字段清单，再照着改。
--
-- 证据库（databases.evidence）建议至少包含这两组信息：
--   · claim：一条可对外表述，及其边界与审批状态
--   · evidence：支撑该 claim 的证据，带等级与有效期
-- 商品库（databases.product）建议至少包含产品名、规格、价格与备案号。

-- ============ 证据库 ============
create table if not exists geo_claim (
  claim_id         text primary key,
  sku_code         text not null,
  claim_text       text not null,
  claim_type       text,                 -- 功效 / 质地 / 价格 / 渠道 / 品牌
  approved_wording text,                 -- 批准表述（对外可直接使用的口径）
  limitations      text,                 -- 适用边界：适用/不适用人群与条件
  status           text not null default 'approved',  -- approved / pending / rejected / archived
  approved_at      date
);

comment on column geo_claim.claim_text  is 'claim 表述；准入会扫描绝对化、医疗、特殊功效词';
comment on column geo_claim.limitations is '必填：没有边界时准入判为“有条件可用”';
comment on column geo_claim.status      is 'pending/rejected/archived 一律禁用';

create table if not exists geo_evidence (
  evidence_id  text primary key,
  claim_id     text not null references geo_claim(claim_id),
  grade        char(1) not null,          -- A 检测/临床/专利  B 专家  C 媒体/白皮书  D UGC  E 品牌自述
  source       text not null,             -- 第三方检测报告 / 消费者测试 / 新华网 …
  source_url   text,
  tested_at    date,
  valid_until  date,                      -- 有效期；为空视为长期有效，过期即禁用
  sample_size  int,
  method       text,                      -- 测试方法与条件
  constraint geo_evidence_grade check (grade in ('A','B','C','D','E'))
);

comment on column geo_evidence.grade is 'E 级仅品牌自述，准入直接判禁用';
create index if not exists geo_evidence_claim_idx on geo_evidence (claim_id);

-- ============ 商品库 ============
create table if not exists geo_sku (
  sku_code      text primary key,
  product_name  text not null,            -- 柔焦蜜粉饼 / 持妆粉底液 5.0（用你自己的产品名）
  brand         text,                     -- 品牌全称
  category      text,                     -- 粉饼 / 粉底液 / 特护 / 色彩线
  spec          text,                     -- 规格，如 7g
  price_cny     numeric(10,2),
  price_updated date,                     -- 价格口径必须带日期
  shelf         text,                     -- 天猫 / 京东 / 抖音商城 / 线下
  skin_types    text,                     -- 适用肤质
  filing_no     text,                     -- 国家药监局备案号
  launched_at   date,
  status        text
);

comment on column geo_sku.filing_no     is '备案号必须与产品页、详情页保持一致';
comment on column geo_sku.price_updated is '价格类回答必须带采集日期，避免过期信息';
