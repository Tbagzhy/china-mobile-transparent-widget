// widget.tsx（中国移动 / CMCC）
// 模块分类 · Widget 渲染入口（业务层）
// 模块分类 · 设计要点
// - 职责：只负责拉数据 + 解析 + 转成统一 CarrierData，然后交给 WidgetRoot 渲染
// - 缓存：本地“固定单文件”存数据（cm_data.json），Storage/BoxJS 只存 meta（updatedAt/keyFp/filename/baseDir）
// - 隔离：cacheScopeKey -> fingerprint 绑定（支持 allowStaleOnKeyMismatch 复用）
// - 模式：auto / cache_only / network_only / cache_disabled（与 cacheSection 一致）
// - 日志：启动 1 行 + 配置消费 1 行 + 缓存策略/决策 1~2 行 + 网络请求 1 行 + 渲染完成 1 行
// - 稳定性：预览不挂死（请求超时兜底）、meta 解析容错、错误信息可读

import { Widget, Text, WidgetReloadPolicy, fetch } from "scripting"

import { WidgetRoot, CarrierData } from "./shared/carrier/widgetRoot"
import { nowHHMM } from "./shared/carrier/utils/carrierUtils"
import { pickUiSettings } from "./shared/carrier/ui"

import {
  SETTINGS_KEY,
  DATA_CACHE_KEY,
  LOGO_URL,
  LOGO_CACHE_KEY,
  type ChinaMobileSettings,
  loadChinaMobileSettings,
  resolveRefreshInterval,
} from "./settings"

import { safeGetObject, safeSetObject } from "./shared/utils/storage"
import {
  readJsonFromSingleFile,
  writeJsonToSingleFileAtomic,
  getCachedImagePath,
} from "./shared/utils/fileCache"

import { errToString, srcLabel, } from "./shared/utils/widgetKit"

// =====================================================================
// 模块分类 · 接口常量（保持原样）
// =====================================================================
const REWRITE_URL = "https://api.example.com/10086/query"
const BUILD_TAG = "v1.0.3"

// =====================================================================
// 模块分类 · 单文件缓存（Storage meta + SingleFile data）
// =====================================================================
// - data：固定 cm_data.json（可选 .bak 用于原子写失败兜底）
// - meta：Storage/BoxJS 仅存 {updatedAt, keyFp, dataFileName, baseDir}

type MobileBoxMeta = {
  updatedAt: number
  keyFp: string
  dataFileName: string
  baseDir: "documents" | "library" | "temporary"
}

// 单文件名：固定，不再产生历史文件，所以不需要 cleanup
const CM_DATA_FILE = "cm_data.json"
const CM_DATA_BAK = "cm_data.bak.json"

function fingerprint(raw: string): string {
  const s = String(raw ?? "")
  let hash = 5381
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash) ^ s.charCodeAt(i)
  return `djb2:${(hash >>> 0).toString(36)}`
}

function toMin(ms: number) {
  return Math.round(ms / 60000)
}

function isWithin(ms: number, now: number, ts: number): boolean {
  return now - ts <= ms
}

function computeTtlMs(settings: ChinaMobileSettings): number {
  const cfg = settings.cache
  const refreshMs = Math.min(30, Math.max(5, settings.refreshInterval || 30)) * 60 * 1000

  if (cfg.ttlPolicy === "fixed") {
    return Math.max(1, cfg.ttlMinutesFixed) * 60 * 1000
  }
  // auto：ttl=refreshInterval；小组件是否准点仍由 iOS 调度决定
  return refreshMs
}

function boundKeyFromSettings(settings: ChinaMobileSettings): string {
  const k = String(settings.cacheScopeKey || "").trim()
  return k ? k : SETTINGS_KEY
}

function readMobileCache(boundKey: string, allowKeyMismatch: boolean): { meta: MobileBoxMeta; data: CarrierData; keyMatched: boolean } | null {
  const meta = safeGetObject<MobileBoxMeta | null>(DATA_CACHE_KEY, null)
  if (!meta) return null

  if (typeof meta.updatedAt !== "number" || !Number.isFinite(meta.updatedAt)) return null
  if (typeof meta.dataFileName !== "string" || !meta.dataFileName) return null
  if (meta.baseDir !== "documents" && meta.baseDir !== "library" && meta.baseDir !== "temporary") return null
  if (typeof meta.keyFp !== "string" || !meta.keyFp) return null

  const wantFp = fingerprint(boundKey)
  const keyMatched = meta.keyFp === wantFp
  if (!keyMatched && !allowKeyMismatch) return null

  const hit = readJsonFromSingleFile<CarrierData>({
    dataFileName: meta.dataFileName,
    baseDir: meta.baseDir,
    backupFileName: CM_DATA_BAK,
  })

  if (!hit?.data) return null
  return { meta, data: hit.data, keyMatched }
}

function writeMobileCache(boundKey: string, data: CarrierData): number {
  const ok = writeJsonToSingleFileAtomic({
    dataFileName: CM_DATA_FILE,
    backupFileName: CM_DATA_BAK,
    baseDir: "documents",
    data,
  })
  if (!ok) throw new Error("writeJsonToSingleFileAtomic failed")

  const now = Date.now()
  const meta: MobileBoxMeta = {
    updatedAt: now,
    keyFp: fingerprint(boundKey),
    dataFileName: CM_DATA_FILE,
    baseDir: "documents",
  }
  safeSetObject(DATA_CACHE_KEY, meta)
  return now
}

// =====================================================================
// 模块分类 · API 请求（保持原方式）
// =====================================================================
function sleep(ms: number) {
  return new Promise<null>((r) => setTimeout(() => r(null), ms))
}

async function loadFromRewriteApi(): Promise<any> {
  try {
    console.log(`📡 数据请求 | 开始 · ${REWRITE_URL}`)

    // 不改地址/方式，仅避免预览卡死：超时就返回 null
    const r = await Promise.race([
      fetch(REWRITE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      sleep(8000),
    ])

    if (!r) {
      console.warn("⏱️ 数据请求 | 超时 · 8000ms")
      return null
    }

    if (r.ok) {
      const json = await r.json()
      if (json?.fee) return json
      console.warn("⚠️ 数据请求 | 返回结构异常 · missing=fee")
      return null
    }

    console.error(`❌ 数据请求 | HTTP 失败 · status=${(r as any).status ?? "-"}`)
  } catch (e) {
    console.error(`❌ 数据请求 | 异常 · ${errToString(e)}`)
  }
  return null
}

// =====================================================================
// 模块分类 · 业务解析（沿用你原来的逻辑，结构保持）
// =====================================================================
type ParsedData = {
  ok: boolean
  fee: { val: string; unit: string; plan: string }
  flowGen: { total: string; used: string; remain: string; unit: "MB" | "GB" }
  flowDir: { total: string; used: string; remain: string; unit: "MB" | "GB" }
  voice: { total: string; used: string; remain: string; unit: string }
  updateTime?: string
}

function parseAnyDate(v: any): number | null {
  if (!v) return null

  if (typeof v === "number") {
    if (v > 1e12) return v
    if (v > 1e9) return v * 1000
  }

  const s = String(v).trim()
  if (!s) return null

  if (/^\d{8}$/.test(s)) {
    const y = +s.slice(0, 4)
    const m = +s.slice(4, 6)
    const d = +s.slice(6, 8)
    return new Date(y, m - 1, d, 23, 59, 59).getTime()
  }

  const t = Date.parse(s.replace(/-/g, "/"))
  return Number.isFinite(t) ? t : null
}

function getPlanExpireMs(plan: any): number | null {
  if (String(plan?.expireFlag) === "1") return 0
  return (
    parseAnyDate(plan?.expireDate) ??
    parseAnyDate(plan?.expireTime) ??
    parseAnyDate(plan?.endDate) ??
    parseAnyDate(plan?.endTime) ??
    null
  )
}

function parseData(res: any): ParsedData {
  try {
    let fee = "0"
    let planFee = "0"
    if (res?.fee) {
      fee = res.fee.curFee ?? res.fee.val ?? "0"
      planFee = res.fee.realFee ?? res.fee.curFeeTotal ?? "0"
    }

    type FlowUnit = "MB" | "GB"
    type FlowVal = { total: string; used: string; remain: string; unit: FlowUnit }

    let flowGen: FlowVal = { total: "0", used: "0", remain: "0", unit: "MB" }
    let flowDir: FlowVal = { total: "0", used: "0", remain: "0", unit: "MB" }
    let voice = { total: "0", used: "0", remain: "0", unit: "分钟" }

    const num = (v: any) => {
      const n = typeof v === "number" ? v : parseFloat(v ?? "0")
      return Number.isFinite(n) ? n : 0
    }

    const fmt = (mb: number) =>
      mb >= 1024
        ? { val: (mb / 1024).toFixed(2), unit: "GB" as const }
        : { val: Math.floor(mb).toString(), unit: "MB" as const }

    if (res?.plan?.planRemianFlowListRes) {
      const list = res.plan.planRemianFlowListRes.planRemianFlowRes || []
      const nowMs = Date.now()

      const buckets = {
        gen: { t: 0, u: 0, r: 0 },
        dir: { t: 0, u: 0, r: 0 },
      }

      let usedDeep = false

      for (const item of list) {
        const type = item.flowtype == "1" ? "dir" : "gen"
        const plans = item.planRemianFlowInfoRes
        if (!Array.isArray(plans)) continue
        usedDeep = true

        for (const plan of plans) {
          const exp = getPlanExpireMs(plan)
          if (exp !== null && exp < nowMs) continue

          const flows = plan.flowInfoRes
          if (!Array.isArray(flows)) continue

          for (const f of flows) {
            let t = num(f.totalRes)
            let u = num(f.usedRes)
            let r = num(f.remainRes)
            if (u === 0 && t > r) u = t - r
            if (t === 0) t = u + r

            buckets[type].t += t
            buckets[type].u += u
            buckets[type].r += r
          }
        }
      }

      if (!usedDeep) {
        for (const item of list) {
          const type = item.flowtype == "1" ? "dir" : "gen"
          let t = num(item.flowSumNum)
          let u = num(item.flowUsdNum)
          let r = num(item.flowRemainNum)
          if (u === 0 && t > r) u = t - r
          if (t === 0) t = u + r
          buckets[type].t += t
          buckets[type].u += u
          buckets[type].r += r
        }
      }

      const g = fmt(buckets.gen.r)
      flowGen = {
        remain: g.val,
        unit: g.unit,
        total: (buckets.gen.t / (g.unit === "GB" ? 1024 : 1)).toFixed(g.unit === "GB" ? 2 : 0),
        used: (buckets.gen.u / (g.unit === "GB" ? 1024 : 1)).toFixed(g.unit === "GB" ? 2 : 0),
      }

      const d = fmt(buckets.dir.r)
      flowDir = {
        remain: d.val,
        unit: d.unit,
        total: (buckets.dir.t / (d.unit === "GB" ? 1024 : 1)).toFixed(d.unit === "GB" ? 2 : 0),
        used: (buckets.dir.u / (d.unit === "GB" ? 1024 : 1)).toFixed(d.unit === "GB" ? 2 : 0),
      }
    }

    if (res?.plan?.planRemianVoiceListRes) {
      const v = res.plan.planRemianVoiceListRes.planRemianVoiceInfoRes?.[0]
      if (v) {
        let t = num(v.voiceSumNum)
        let u = num(v.voiceUsdNum)
        let r = num(v.voiceRemainNum)
        if (u === 0 && t > r) u = t - r
        voice = {
          total: Math.floor(t).toString(),
          used: Math.floor(u).toString(),
          remain: Math.floor(r).toString(),
          unit: "分钟",
        }
      }
    }

    return {
      ok: true,
      fee: { val: String(fee), unit: "元", plan: String(planFee) },
      flowGen,
      flowDir,
      voice,
      updateTime: nowHHMM(),
    }
  } catch (e) {
    console.error(`❌ 解析 | 异常 · ${errToString(e)}`)
  }

  return {
    ok: false,
    fee: { val: "0", unit: "元", plan: "0" },
    flowGen: { total: "0", used: "0", remain: "0", unit: "MB" },
    flowDir: { total: "0", used: "0", remain: "0", unit: "MB" },
    voice: { total: "0", used: "0", remain: "0", unit: "分钟" },
    updateTime: nowHHMM(),
  }
}

// =====================================================================
// 模块分类 · 转成统一 CarrierData（联通同款字段）
// =====================================================================
function safeN(v: any): number {
  const n = typeof v === "number" ? v : parseFloat(v ?? "0")
  return Number.isFinite(n) ? n : 0
}

function convertToCarrierData(p: ParsedData): CarrierData {
  const gF = p.flowGen.unit === "GB" ? 1024 : 1
  const dF = p.flowDir.unit === "GB" ? 1024 : 1

  return {
    fee: { title: "剩余话费", balance: p.fee.val, unit: p.fee.unit },
    flow: {
      title: "通用流量",
      balance: p.flowGen.remain,
      unit: p.flowGen.unit,
      used: safeN(p.flowGen.used) * gF,
      total: safeN(p.flowGen.total) * gF,
    },
    otherFlow: {
      title: "定向流量",
      balance: p.flowDir.remain,
      unit: p.flowDir.unit,
      used: safeN(p.flowDir.used) * dF,
      total: safeN(p.flowDir.total) * dF,
    },
    voice: {
      title: "剩余语音",
      balance: p.voice.remain,
      unit: p.voice.unit,
      used: safeN(p.voice.used),
      total: safeN(p.voice.total),
    },
    updateTime: `${p.updateTime ?? nowHHMM()}·${BUILD_TAG}`,
  }
}

// =====================================================================
// 模块分类 · 主渲染入口
// =====================================================================
async function render() {
  const t0 = Date.now()

  console.log(`🚀 组件启动 | carrier=CMCC | run=${nowHHMM()}`)

  const settings = loadChinaMobileSettings()
  const ui = pickUiSettings(settings)

  // 刷新间隔：更激进，尽量让系统更早尝试刷新
  const refreshInterval = Math.min(30, Math.max(15, resolveRefreshInterval(settings.refreshInterval, 30)))
  const nextUpdate = new Date(Date.now() + refreshInterval * 60 * 1000)
  const reloadPolicy: WidgetReloadPolicy = { policy: "after", date: nextUpdate }

  // 以缓存为主，避免桌面组件每次唤醒都请求接口；缓存过期后再联网。
  const forceRefresh = settings.cache?.mode === "network_only"

  // ===================================================================
  // 模块分类 · 配置消费日志（单行）
  // ===================================================================
  const ttlMs = computeTtlMs(settings)
  const allowKeyMismatch = settings.cache.allowStaleOnKeyMismatch !== false

  console.log(
    `⚙️ 配置读取 | ` +
    `refresh=${refreshInterval}min` +
    ` | cacheEnabled=${settings.cache.enabled ? "Y" : "N"}` +
    ` | cacheMode=${settings.cache.mode}` +
    ` | ttlPolicy=${settings.cache.ttlPolicy}` +
    ` | ttl=${toMin(ttlMs)}min` +
    ` | ttlFixed=${settings.cache.ttlMinutesFixed}min` +
    ` | allowStale=${settings.cache.allowStaleOnError ? "Y" : "N"}` +
    ` | maxStale=${settings.cache.maxStaleMinutes}min` +
    ` | allowKeyMismatch=${allowKeyMismatch ? "Y" : "N"}` +
    ` | force=${forceRefresh ? "Y" : "N"}`,
  )

  // ===================================================================
  // 模块分类 · 缓存读取 + 决策
  // ===================================================================
  const boundKey = boundKeyFromSettings(settings)
  const boundKeyFp = fingerprint(boundKey).slice(0, 12)
  const now = Date.now()

  const hit = settings.cache.enabled ? readMobileCache(boundKey, allowKeyMismatch) : null
  const meta = hit?.meta ?? null
  const cached = hit?.data ?? null

  const cacheAgeMin = meta?.updatedAt ? toMin(now - meta.updatedAt) : undefined
  const keyMatched = hit ? hit.keyMatched : undefined
  const fresh = !!meta?.updatedAt && isWithin(ttlMs, now, meta.updatedAt)

  // 决策日志（交管风格：策略 + 决策）
  console.log(
    `🧠 缓存策略：` +
    `启用=${settings.cache.enabled ? "Y" : "N"}` +
    `｜模式=${settings.cache.mode}` +
    `｜TTL=${toMin(ttlMs)}分钟` +
    `｜兜底=${settings.cache.allowStaleOnError ? "允许" : "禁止"}` +
    `｜最大陈旧=${Math.max(1, settings.cache.maxStaleMinutes)}分钟` +
    `｜刷新=${refreshInterval}分钟` +
    `｜强制刷新=${forceRefresh ? "是" : "否"}` +
    `｜当前缓存=${cacheAgeMin == null ? "-" : `${cacheAgeMin}分钟`}` +
    `｜keyMatched=${keyMatched === undefined ? "-" : keyMatched ? "Y" : "N"}` +
    `｜boundKey=${boundKeyFp}`,
  )

  let cachedData: CarrierData | null = null
  let decision = "none"

  // cache_disabled：不读缓存，但网络成功仍写入
  if (settings.cache.enabled === false) {
    decision = "cache_disabled(read_off)"
  } else if (settings.cache.mode === "cache_only") {
    if (cached) {
      cachedData = cached
      decision = keyMatched ? "cache_only -> hit" : "cache_only -> hit(key_mismatch_reuse)"
    } else {
      decision = "cache_only -> miss"
    }
  } else if (settings.cache.mode !== "network_only") {
    if (cached && fresh && !forceRefresh) {
      cachedData = cached
      decision = keyMatched ? "auto -> cache_fresh" : "auto -> cache_fresh(key_mismatch_reuse)"
    } else {
      decision = forceRefresh ? "auto -> force_refresh" : "auto -> need_network"
    }
  } else {
    decision = "network_only -> need_network"
  }

  // 命中缓存：直接渲染
  if (cachedData) {
    console.log(`🧠 缓存决策：${decision} | age=${cacheAgeMin ?? "-"}min`)

    const tag = fresh ? "缓存" : "缓存(旧)"
    const dataForRender: CarrierData = { ...cachedData, updateTime: `${nowHHMM()}·${tag}·${BUILD_TAG}` }

    const logoPath = await getCachedImagePath({
      url: LOGO_URL,
      cacheKey: LOGO_CACHE_KEY,
      filePrefix: "cm_logo",
      fileExt: "png",
      baseDir: "documents",
      // 不传 keepLatest：与你现有 fileCache 类型保持一致
    })

    console.log(
      logoPath
        ? `🖼️ Logo：local_ok · path=${logoPath}`
        : `🖼️ Logo：miss/timeout · continue_render`,
    )

    console.log(`✅ 渲染完成 | run=${nowHHMM()} | src=${srcLabel("local", true)} | cost=${Date.now() - t0}ms | decision=${decision}`)
    Widget.present(<WidgetRoot data={dataForRender} ui={ui} logoPath={logoPath} />, reloadPolicy)
    return
  }

  // cache_only 且 miss：直接失败
  if (settings.cache.enabled !== false && settings.cache.mode === "cache_only") {
    console.warn("⚠️ 缓存决策：cache_only -> miss（无可用缓存）")
    Widget.present(<Text>⚠️ 无可用缓存（cache_only）</Text>, reloadPolicy)
    return
  }

  // ===================================================================
  // 模块分类 · 网络请求
  // ===================================================================
  const api = await loadFromRewriteApi()

  if (!api) {
    console.warn("⚠️ 数据请求 | 空返回")

    // 网络失败：允许用旧缓存兜底
    if (settings.cache.enabled && settings.cache.allowStaleOnError && cached && meta?.updatedAt) {
      const maxStaleMs = Math.max(1, settings.cache.maxStaleMinutes) * 60 * 1000
      const within = isWithin(maxStaleMs, Date.now(), meta.updatedAt)

      console.warn(
        `🧠 缓存决策：网络失败 → ${within ? "启用兜底缓存" : "兜底失败(过期)"} | ` +
        `age=${cacheAgeMin ?? "-"}min | maxStale=${toMin(maxStaleMs)}min`,
      )

      if (within) {
        const logoPath = await getCachedImagePath({
          url: LOGO_URL,
          cacheKey: LOGO_CACHE_KEY,
          filePrefix: "cm_logo",
          fileExt: "png",
          baseDir: "documents",
        })

        const dataForRender: CarrierData = { ...cached, updateTime: `${nowHHMM()}·兜底缓存·${BUILD_TAG}` }

        console.log(
          logoPath
            ? `🖼️ Logo：local_ok · path=${logoPath}`
            : `🖼️ Logo：miss/timeout · continue_render`,
        )

        console.log(`✅ 渲染完成 | run=${nowHHMM()} | src=${srcLabel("local", true)} | cost=${Date.now() - t0}ms | decision=stale_fallback`)
        Widget.present(<WidgetRoot data={dataForRender} ui={ui} logoPath={logoPath} />, reloadPolicy)
        return
      }
    }

    Widget.present(<Text>获取数据失败，请确保已安装重写规则。</Text>, reloadPolicy)
    return
  }

  const parsed = parseData(api)
  if (!parsed.ok) {
    console.error("❌ 解析失败 | parseData=not_ok")
    Widget.present(<Text>解析数据失败，请检查返回结构。</Text>, reloadPolicy)
    return
  }

  const mergedData = convertToCarrierData(parsed)

  // ===================================================================
  // 模块分类 · 写缓存（成功才写）
  // ===================================================================
  try {
    const cacheUpdatedAt = writeMobileCache(boundKey, mergedData)
    console.log(`💾 写缓存成功 | updatedAt=${cacheUpdatedAt} | boundKey=${fingerprint(boundKey).slice(0, 12)}`)
  } catch (e) {
    console.warn(`⚠️ 写缓存异常 | ${errToString(e)}`)
  }

  const logoPath = await getCachedImagePath({
    url: LOGO_URL,
    cacheKey: LOGO_CACHE_KEY,
    filePrefix: "cm_logo",
    fileExt: "png",
    baseDir: "documents",
  })

  console.log(
    logoPath
      ? `🖼️ Logo：local_ok · path=${logoPath}`
      : `🖼️ Logo：miss/timeout · continue_render`,
  )

  console.log(`✅ 渲染完成 | run=${nowHHMM()} | src=${srcLabel("network", false)} | cost=${Date.now() - t0}ms | decision=network_ok`)
  Widget.present(<WidgetRoot data={mergedData} ui={ui} logoPath={logoPath} />, reloadPolicy)
}

render()