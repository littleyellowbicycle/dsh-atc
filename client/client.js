/**
 * dsh-atc — browser half.
 *
 * Adds a global main panel (a sidebar row like Plugins / Automations) that
 * lists every local agent session. The host already did all inference; this
 * half only renders and navigates.
 *
 * Visual language: one dashboard, not one list.
 *   KPI tiles → activity heatmap → agent donut → status bar → session rows.
 * Every number on screen comes from the local payload; nothing is invented.
 */

window.__ModuleLoader__.load({
  id: 'dsh-atc',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const PANEL_ID = 'atc'
    const ENDPOINT = '/dsh-atc/data'
    const OPEN_ENDPOINT = '/dsh-atc/open'
    const POLL_MS = 5000
    const DAY = 86_400_000

    /* ---------------------------------------------------------------- store */

    const store = { data: null, error: null, at: 0, paused: false, listeners: new Set() }

    /**
     * Ask the host to open this row in its own tool.
     *
     * Resolves true only when a terminal was actually started; anything else
     * (no opener for the tool, an unsupported platform, a bad id) resolves false
     * so the caller can fall back to copying the path.
     */
    async function requestOpen(item) {
      try {
        const response = await fetch(OPEN_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tool: item.tool, openId: item.openId, cwd: item.cwd }),
        })
        if (!response.ok) return false
        const result = await response.json()
        return result?.ok === true
      } catch {
        return false
      }
    }

    function publish(patch) {
      Object.assign(store, patch)
      for (const listener of store.listeners) listener()
    }

    let timer = null
    let inflight = false

    async function refresh() {
      if (inflight) return
      inflight = true
      try {
        const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        publish({ data: await response.json(), error: null, at: Date.now() })
      } catch (error) {
        publish({ error: String(error && error.message ? error.message : error) })
      } finally {
        inflight = false
      }
    }

    function startPolling() {
      if (timer !== null) return () => {}
      refresh()
      // A paused board keeps its last snapshot: screenshots and demos should
      // not have rows moving under the cursor.
      timer = setInterval(() => {
        if (!store.paused) refresh()
      }, POLL_MS)
      return () => {
        if (timer !== null) clearInterval(timer)
        timer = null
      }
    }

    function useBoard() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((value) => value + 1)
        store.listeners.add(listener)
        const stop = startPolling()
        return () => {
          store.listeners.delete(listener)
          if (store.listeners.size === 0) stop()
        }
      }, [])
      return store
    }

    /* ------------------------------------------------------------- hidden */

    /**
     * Rows the user removed from the board. This is a display-only list: the
     * stores themselves are never touched, so a hidden session keeps running
     * and can be brought back at any time.
     */
    const HIDDEN_KEY = 'dsh-atc:hidden'

    /** Stable identity of one row across polls. */
    function itemKey(item) {
      return `${item.tool}:${item.key ?? item.sessionId ?? item.workspace}`
    }

    function loadHidden() {
      try {
        const raw = globalThis.localStorage?.getItem(HIDDEN_KEY)
        const list = raw ? JSON.parse(raw) : []
        return new Set(Array.isArray(list) ? list : [])
      } catch {
        return new Set()
      }
    }

    /**
     * Sessions the reader starred. A star is a deliberate "I care about this
     * one" signal, so starred rows are lifted out of the status bands and shown
     * first — a finished session you are watching should not sink to "older".
     */
    const STAR_KEY = 'dsh-atc:starred'

    function loadStarred() {
      try {
        const raw = globalThis.localStorage?.getItem(STAR_KEY)
        const list = raw ? JSON.parse(raw) : []
        return new Set(Array.isArray(list) ? list : [])
      } catch {
        return new Set()
      }
    }

    function saveStarred(set) {
      try {
        globalThis.localStorage?.setItem(STAR_KEY, JSON.stringify([...set]))
      } catch {
        /* a blocked storage must not break starring within this session */
      }
    }

    function saveHidden(set) {
      try {
        globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify([...set]))
      } catch {
        /* a blocked storage must not break hiding within this session */
      }
    }

    /* ------------------------------------------------------------- vocabulary */

    /**
     * Chart palette. The host exposes semantic state tokens for text and
     * borders, but a donut / heatmap needs discrete hues it does not ship,
     * so the categorical set lives here and is mirrored into CSS variables.
     */
    const PALETTE = {
      blue: '#4c7cf3',
      green: '#2f9e6f',
      amber: '#d98324',
      red: '#d9534f',
      purple: '#7c5cf0',
      teal: '#12b0a0',
      pink: '#e05fa8',
      slate: '#8b949e',
    }

    /** status → label, dot color, pill tint, and what the label actually means. */
    const STATUS = {
      running: {
        label: '在跑',
        color: PALETTE.green,
        soft: 'rgba(47,158,111,.12)',
        hint: '存储自带 running/active，或刚刚还有动静',
      },
      'needs-you': {
        label: '等你',
        color: PALETTE.amber,
        soft: 'rgba(217,131,36,.14)',
        hint: '存储自带 wait/pending/confirm/approv —— 在等你拍板',
      },
      failed: {
        label: '失败',
        color: PALETTE.red,
        soft: 'rgba(217,83,79,.12)',
        hint: '存储自带 error，且是最近才失败的（更早的失败只算历史）',
      },
      done: {
        label: '完成',
        color: PALETTE.teal,
        soft: 'rgba(18,176,160,.12)',
        hint: '存储自带 completed/archived —— 归档的会话也算完成',
      },
      stopped: {
        label: '中止',
        color: '#6e7781',
        soft: 'rgba(110,119,129,.12)',
        hint: '被中止的终态：存储自带 terminated / cancel / stop / aborted',
      },
      recent: {
        label: '刚动过',
        color: PALETTE.slate,
        soft: 'rgba(139,148,158,.12)',
        hint: '半小时内动过，但存储没说它结束 —— 这是时间，不是终态',
      },
      idle: {
        label: '长期无动静',
        color: '#aeb6c0',
        soft: 'rgba(174,182,192,.14)',
        hint: '半小时以上没动，存储也没说它结束 —— 不代表已归档',
      },
    }

    /**
     * Status marks, one shape per state.
     *
     * The agents now carry real brand logos, which leaves colour as the only
     * thing telling the states apart — the very thing we just got rid of on
     * the agent side. These marks are strokes, the brand logos are fills, so
     * the two dimensions never read as the same kind of thing: filled = who,
     * lined = what state.
     */
    const STATUS_SHAPES = {
      running: [
        {
          tag: 'path',
          attrs: {
            d: 'M4.4 2.9 9.2 6l-4.8 3.1z',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            fill: 'none',
            strokeLinejoin: 'round',
          },
        },
      ],
      'needs-you': [
        {
          tag: 'path',
          attrs: {
            d: 'M6 2.3v4.3',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            fill: 'none',
            strokeLinecap: 'round',
          },
        },
        { tag: 'circle', attrs: { cx: 6, cy: 9.3, r: 0.8, fill: 'currentColor' } },
      ],
      failed: [
        {
          tag: 'path',
          attrs: {
            d: 'M3.7 3.7 8.3 8.3M8.3 3.7 3.7 8.3',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            fill: 'none',
            strokeLinecap: 'round',
          },
        },
      ],
      done: [
        {
          tag: 'path',
          attrs: {
            d: 'M2.9 6.3 4.9 8.4 9.1 3.7',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            fill: 'none',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
        },
      ],
      stopped: [
        { tag: 'circle', attrs: { cx: 6, cy: 6, r: 4.2, stroke: 'currentColor', strokeWidth: 1.5, fill: 'none' } },
        {
          tag: 'path',
          attrs: {
            d: 'M3.4 3.4 8.6 8.6',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            fill: 'none',
            strokeLinecap: 'round',
          },
        },
      ],
      recent: [
        { tag: 'circle', attrs: { cx: 6, cy: 6, r: 4.2, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' } },
        {
          tag: 'path',
          attrs: {
            d: 'M6 3.5V6l1.9 1.3',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            fill: 'none',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
        },
      ],
      idle: [
        {
          tag: 'path',
          attrs: {
            d: 'M9.4 8.8A4.1 4.1 0 0 1 4.2 3.6a4.3 4.3 0 1 0 5.2 5.2z',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            fill: 'none',
            strokeLinejoin: 'round',
          },
        },
      ],
    }

    /** One state mark, in the colour of the state it stands for. */
    function StatusGlyph({ status, size = 12, color }) {
      const parts = STATUS_SHAPES[status] || STATUS_SHAPES.idle
      return h(
        'svg',
        {
          className: 'fb-status-glyph',
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: color ? { '--fb-status-color': color } : undefined,
        },
        parts.map((part, index) => h(part.tag, { key: index, ...part.attrs })),
      )
    }

    /**
     * Only these states are worth a filter chip. 刚停 / 无动静 are catch-all
     * buckets: they only say "nothing happened lately", and filtering by them
     * just reproduces the 更早 band.
     */
    const FILTERABLE_STATUSES = ['running', 'needs-you', 'failed', 'done']

    /**
     * Agent identity is a *shape*, not a colour.
     *
     * Nine agents cannot live on eight hues: two of them always end up
     * looking alike, and a colour-blind reader tells none of them apart.
     * So every agent owns a distinct silhouette, and hue only repeats what
     * the shape already says. These are abstract marks, not brand logos.
     */
    // <brand-icons>
    /**
     * Real brand marks, one path each on a 24×24 viewBox. Generated from
     * simple-icons by `scripts/build-brand-icons.mjs` — do not hand-edit.
     * A tool absent here keeps its geometric glyph on purpose: no invented logo.
     */
    const BRAND_ICONS = {
      dsh: { hex: '#5786FE', title: "DeepSeek", path: 'M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45' },
      opencode: { hex: '#000000', title: "OpenCode", path: 'M22 24H2V0h20zM17 4.8H7v14.4h10z' },
      workbuddy: { hex: '#6C4DFF', title: "CodeBuddy", path: 'M18.636.289a1 1 0 0 0-.11 0c-.18.01-.195.02-.442.24-.716.636-1.722 2.546-2.703 5.137l-.274.72-.499.16c-1.554.498-2.934 1.128-4.157 1.893-1.174.73-1.81 1.207-2.768 2.056l-.578.51-.262-.045c-2.528-.447-4.8-.612-5.843-.43-.414.077-.757.216-.862.35-.092.12-.138.263-.138.474 0 .182.034.414.098.727.265 1.236.952 2.854 2.035 4.78l.7 1.236-.023.466c-.027.499 0 1.27.06 1.793.036.319.031.327-.135.516-.565.647-.708 1.676-.408 2.84h5.364l-.33-.57c-.64-1.108-.96-1.663-1.134-2.177a5.46 5.46 0 0 1 1.564-5.84c.408-.358.962-.678 2.072-1.32l6.38-3.683c1.11-.64 1.665-.96 2.18-1.134A5.46 5.46 0 0 1 24 10.275V6.462l-.117-.06-.504-.25-.357-.662c-.924-1.702-2.41-3.696-3.477-4.666-.4-.364-.655-.517-.91-.535M11.57 17.634a1.26 1.26 0 0 1 1.722.462l1.358 2.35c.842 1.455-1.341 2.717-2.183 1.262l-1.358-2.352a1.26 1.26 0 0 1 .461-1.722m6.802-3.926a1.26 1.26 0 0 1 1.721.46l1.358 2.352c.84 1.455-1.343 2.715-2.183 1.26l-1.358-2.35a1.26 1.26 0 0 1 .462-1.722' },
      gemini: { hex: '#8E75B2', title: "Google Gemini", path: 'M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81' },
      minimax: { hex: '#E73562', title: "MiniMax", path: 'M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997' },
      claude: { hex: '#D97757', title: "Claude", path: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z' },
      trae: { hex: '#32F08C', title: "TRAE", path: 'M24 20.5H3.5V17H0V3.5h24ZM3.5 17h17V7h-17Zm8.5-5-2.5 2.5L7 12l2.5-2.5Zm7 0-2.5 2.5L14 12l2.5-2.5z' },
      cursor: { hex: '#000000', title: "Cursor", path: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23' },
      windsurf: { hex: '#0B100F', title: "Windsurf", path: 'M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z' },
      qwen: { hex: '#6950EF', title: "QWen", path: 'M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z' },
    }
    // </brand-icons>

    const AGENT_GLYPH = {
      dsh: 'disc',
      codex: 'hex',
      opencode: 'chevron',
      workbuddy: 'square',
      gemini: 'star',
      zcode: 'zcode',
      minimax: 'triangle',
      trae: 'ring',
      claude: 'asterisk',
    }

    /** The hue that repeats the shape — never the primary identifier. */
    const AGENT_COLOR = {
      dsh: PALETTE.blue,
      codex: PALETTE.green,
      opencode: PALETTE.amber,
      workbuddy: PALETTE.purple,
      gemini: PALETTE.pink,
      zcode: PALETTE.teal,
      minimax: PALETTE.red,
      claude: '#d97757',
      trae: '#3aa0c9',
    }

    /** Brand hue where one exists, so icon and bar agree. */
    for (const [tool, icon] of Object.entries(BRAND_ICONS)) {
      AGENT_COLOR[tool] = icon.hex
    }

    /** Shape geometry, drawn on a 12×12 grid so every mark is optically equal. */
    const GLYPH_SHAPES = {
      disc: [{ tag: 'circle', attrs: { cx: 6, cy: 6, r: 4.2, fill: 'currentColor' } }],
      hex: [
        {
          tag: 'path',
          attrs: {
            d: 'M6 1.3 10.1 3.6v4.8L6 10.7 1.9 8.4V3.6z',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            fill: 'none',
            strokeLinejoin: 'round',
          },
        },
      ],
      chevron: [
        {
          tag: 'path',
          attrs: {
            d: 'M4.2 2.6 8 6l-3.8 3.4',
            stroke: 'currentColor',
            strokeWidth: 1.7,
            fill: 'none',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
        },
      ],
      square: [{ tag: 'rect', attrs: { x: 2, y: 2, width: 8, height: 8, rx: 2.2, fill: 'currentColor' } }],
      star: [
        {
          tag: 'path',
          attrs: { d: 'M6 .6 7.4 4.6 11.4 6 7.4 7.4 6 11.4 4.6 7.4 .6 6 4.6 4.6z', fill: 'currentColor' },
        },
      ],
      zcode: [
        {
          tag: 'path',
          attrs: {
            d: 'M2.6 2.9h6.8L2.6 9.1h6.8',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            fill: 'none',
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
        },
      ],
      triangle: [
        {
          tag: 'path',
          attrs: {
            d: 'M6 2 10.4 9.6H1.6z',
            stroke: 'currentColor',
            strokeWidth: 1.5,
            fill: 'none',
            strokeLinejoin: 'round',
          },
        },
      ],
      ring: [
        { tag: 'circle', attrs: { cx: 6, cy: 6, r: 3.8, stroke: 'currentColor', strokeWidth: 1.6, fill: 'none' } },
      ],
      asterisk: [
        {
          tag: 'path',
          attrs: {
            d: 'M6 1.4v9.2M1.4 6h9.2M2.7 2.7l6.6 6.6M9.3 2.7l-6.6 6.6',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            fill: 'none',
            strokeLinecap: 'round',
          },
        },
      ],
      /** Anything we have no mark for yet: a broken ring, clearly "unknown". */
      dashed: [
        {
          tag: 'circle',
          attrs: {
            cx: 6,
            cy: 6,
            r: 3.8,
            stroke: 'currentColor',
            strokeWidth: 1.4,
            fill: 'none',
            strokeDasharray: '2 1.9',
          },
        },
      ],
    }

    /** The mark that identifies an agent; unknown tools fall back to a dashed ring. */
    function agentGlyph(tool) {
      return AGENT_GLYPH[tool] || 'dashed'
    }

    /**
     * The mark that identifies an agent: the real brand logo when one is
     * published, the geometric silhouette otherwise.
     */
    function AgentGlyph({ tool, size = 12, color }) {
      const brand = BRAND_ICONS[tool]
      if (brand) {
        return h(
          'svg',
          {
            className: 'fb-glyph fb-glyph-brand',
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'currentColor',
            role: 'img',
            'aria-label': brand.title,
            focusable: 'false',
            style: { color: brand.hex },
          },
          h('path', { d: brand.path }),
        )
      }
      return h(
        'svg',
        {
          className: 'fb-glyph',
          width: size,
          height: size,
          viewBox: '0 0 12 12',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: color ? { '--fb-agent-color': color } : undefined,
        },
        GLYPH_SHAPES[agentGlyph(tool)].map((part, index) => h(part.tag, { key: index, ...part.attrs })),
      )
    }

    /** Status order used by the stacked bar and the legend. */
    const STATUS_ORDER = ['running', 'needs-you', 'failed', 'done', 'stopped', 'recent', 'idle']

    /**
     * Windows for the agent distribution. "All" counts history, so whoever keeps
     * the most old sessions wins — true but useless. A rolling window answers
     * the question a dashboard is for: who has been working lately.
     */
    const AGENT_SCOPES = [
      { key: 'd1', label: '近 24h', ms: DAY },
      { key: 'd7', label: '近 7 天', ms: 7 * DAY },
      { key: 'all', label: '全部', ms: Infinity },
    ]

    /** Time windows; `all` keeps the historical default of showing everything. */
    const RANGES = [
      { key: 'today', label: '今天', ms: DAY },
      { key: 'd7', label: '近 7 天', ms: 7 * DAY },
      { key: 'd30', label: '近 30 天', ms: 30 * DAY },
      { key: 'all', label: '全部', ms: Infinity },
    ]

    /** Sort modes for the session list. */
    const SORTS = [
      { key: 'time', label: '最近更新' },
      { key: 'tool', label: '按工具' },
      { key: 'workspace', label: '按工作区' },
    ]

    /** Heatmap scale: empty cell first, then four blue steps. */
    const HEAT_EMPTY = '#f0f2f5'
    const HEAT_SCALE = ['#dbe7fd', '#b5cffb', '#82aaf7', '#5b8bf2', '#3b6ef6']

    function ago(ms) {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff < 0) return '刚刚'
      if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))} 秒前`
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
      return `${Math.round(diff / 86_400_000)} 天前`
    }

    /** Wall-clock time, for the "last updated" stamp. */
    function clockTime(ms) {
      if (!ms) return '--:--:--'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Calendar day label, e.g. `11-14`. */
    function dayLabel(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Full date label, e.g. `2026-11-14`. */
    function fullDate(ms) {
      if (!ms) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Local midnight of the day containing `ms`. */
    function dayStart(ms) {
      const date = new Date(ms)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
    }

    /**
     * Toggle one filter value. Picking the value that is already selected
     * releases it — a filter you cannot take off again is a trap.
     * @param current - the value currently selected ('all' means none).
     * @param value - the value the user just picked.
     * @returns the next selection.
     */
    function toggleFilter(current, value) {
      return current === value ? 'all' : value
    }

    /**
     * Select a Session in the host UI. `uiWorkspace.openSession` is what the
     * shipped plugins call; `sessions.open` is kept as a fallback.
     */
    function openSession(ctx, sessionId) {
      if (!sessionId) return false
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(sessionId)
          return true
        }
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        if (sessions && typeof sessions.open === 'function') {
          sessions.open(sessionId)
          return true
        }
      } catch {
        /* navigation is best effort */
      }
      return false
    }

    /** Put a string on the clipboard; the fallback is the caller's own message. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------- derivation */

    /** Split the flat payload into the bands a human actually triages. */
    /**
     * Group rows for reading, not for statistics.
     *
     * The first three bands come from what the store asserts (a turn is open, a
     * turn ended with a reason). The last two are only age — and they are kept
     * apart from the terminal states on purpose: "just ended" and "quiet for a
     * while" are different facts, and merging them made 完成 look like 中止.
     */
    function band(items) {
      const attention = []
      const running = []
      const ended = []
      const active = []
      const older = []
      const cutoff = Date.now() - 30 * 60_000
      const endedCutoff = Date.now() - 24 * 60 * 60_000
      const terminal = new Set(['done', 'stopped'])
      for (const item of items) {
        if (item.status === 'needs-you' || item.status === 'failed') attention.push(item)
        else if (item.status === 'running') running.push(item)
        else if (terminal.has(item.status) && item.lastActivity >= endedCutoff) ended.push(item)
        else if (item.lastActivity >= cutoff) active.push(item)
        else older.push(item)
      }
      return { attention, running, ended, active, older }
    }

    /** Apply the visible filters (search, window, status, agent). */
    function filterItems(items, filters) {
      const range = RANGES.find((entry) => entry.key === filters.range) ?? RANGES[RANGES.length - 1]
      const floor = Date.now() - range.ms
      const needle = filters.query.trim().toLowerCase()
      return items.filter((item) => {
        if (range.ms !== Infinity && item.lastActivity < floor) return false
        if (filters.status !== 'all' && item.status !== filters.status) return false
        if (filters.tool !== 'all' && item.tool !== filters.tool) return false
        if (!needle) return true
        const haystack = `${item.title} ${item.workspace} ${item.detail} ${item.tool}`.toLowerCase()
        return haystack.includes(needle)
      })
    }

    /** Sort inside a band without ever losing the band order itself. */
    function sortItems(items, sortKey) {
      const sorted = items.slice()
      if (sortKey === 'tool') {
        sorted.sort((a, b) => a.tool.localeCompare(b.tool) || b.lastActivity - a.lastActivity)
      } else if (sortKey === 'workspace') {
        sorted.sort(
          (a, b) => a.workspace.localeCompare(b.workspace) || b.lastActivity - a.lastActivity,
        )
      } else {
        sorted.sort((a, b) => b.lastActivity - a.lastActivity)
      }
      return sorted
    }

    /** Sessions per agent, for the donut and the legend. */
    function toolBreakdown(items) {
      const counts = new Map()
      for (const item of items) counts.set(item.tool, (counts.get(item.tool) || 0) + 1)
      return [...counts.entries()]
        .map(([tool, value]) => ({ key: tool, label: tool, value, color: AGENT_COLOR[tool] || PALETTE.slate }))
        .sort((a, b) => b.value - a.value)
    }

    /** Sessions per status, for the stacked bar and its legend. */
    function statusBreakdown(items) {
      const counts = new Map()
      for (const item of items) counts.set(item.status, (counts.get(item.status) || 0) + 1)
      return STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({
        key: status,
        label: STATUS[status].label,
        value: counts.get(status),
        color: STATUS[status].color,
      }))
    }

    /**
     * GitHub-style activity heatmap: columns are weeks, rows are weekdays.
     * @param items - the sessions to count.
     * @param weeks - how many weeks to show.
     * @returns columns (each with a month label) plus the busiest day count.
     */
    function activityHeatmap(items, weeks = 6) {
      const today = dayStart(Date.now())
      const start = today - (weeks * 7 - 1) * DAY
      // Align the first column to a Sunday so the weekday rows stay true.
      const offset = new Date(start).getDay()
      const gridStart = start - offset * DAY
      const counts = new Map()
      for (const item of items) {
        const key = dayStart(item.lastActivity)
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      const columns = []
      let lastMonth = -1
      for (let column = 0; ; column += 1) {
        const first = gridStart + column * 7 * DAY
        if (first > today + DAY) break
        const cells = []
        for (let row = 0; row < 7; row += 1) {
          const time = first + row * DAY
          cells.push({ time, count: time > today ? -1 : counts.get(time) || 0 })
        }
        const month = new Date(first).getMonth()
        columns.push({ cells, label: month !== lastMonth ? `${month + 1}月` : '' })
        lastMonth = month
      }
      const max = Math.max(
        1,
        ...columns.flatMap((column) => column.cells.map((cell) => Math.max(0, cell.count))),
      )
      let busiest = { time: 0, count: 0 }
      for (const [time, count] of counts) {
        if (count > busiest.count) busiest = { time, count }
      }
      return { columns, max, busiest }
    }

    /** Bucket a day count onto the 5-step blue scale. */
    function heatColor(count, max) {
      if (count <= 0) return HEAT_EMPTY
      const ratio = count / max
      const step = Math.min(HEAT_SCALE.length - 1, Math.floor(ratio * HEAT_SCALE.length))
      return HEAT_SCALE[step]
    }

    /* ------------------------------------------------------------- components */

    function RefreshIcon({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.1' }),
        h('path', { d: 'M20 4v7h-7' }),
      )
    }

    function SearchIcon({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M20 20l-3.6-3.6' }),
      )
    }

    function CheckIcon({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 12.5l5 5L20 6.5' }),
      )
    }

    /**
     * The panel's sidebar glyph: a control tower broadcasting one arc.
     *
     * The host draws its own sidebar icons on a 16px canvas with a 2px stroke,
     * and its glyphs land at 75–121px of ink over a 14×16 footprint. This one
     * is drawn to the same brief: the drawing fills the viewBox, the strokes
     * carry the host's weight, and the ink spreads across the whole width
     * instead of piling into one blob.
     *
     * A second arc was cut on purpose. At 16px two concentric arcs and a
     * tower cannot keep white space between their strokes, and they merge into
     * a smudge; one bold arc reads as a broadcast and holds the right edge of
     * the canvas.
     */
    function PanelIcon({ size = 18 }) {
      const state = useBoard()
      const attention = state.data ? state.data.attention : 0
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        // Mast, cabin, tapered body, and the base it stands on.
        h('path', { d: 'M8.6 1.8V4.4' }),
        h('rect', { x: 4.9, y: 4.4, width: 7.4, height: 4.8, rx: 1.4 }),
        h('path', { d: 'M6.3 9.2 4 21M10.9 9.2 13.2 21' }),
        h('path', { d: 'M2 21H15.2' }),
        // The broadcast arc, opening away from the cabin.
        h('path', { d: 'M17.4 5a4.6 4.6 0 0 1 0 9.2' }),
        attention > 0
          ? h('circle', { cx: 20.8, cy: 3.2, r: 2, fill: 'var(--dsw-alias-state-warn-primary)', stroke: 'none' })
          : null,
      )
    }

    /** Segmented control, dark filled active state. */
    function Segmented({ options, value, onChange }) {
      return h(
        'div',
        { className: 'fb-seg' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.key,
              type: 'button',
              className: `fb-seg-item${option.key === value ? ' fb-seg-item-active' : ''}`,
              onClick: () => onChange(option.key),
            },
            option.label,
          ),
        ),
      )
    }

    /** One KPI tile: big number, label, optional footnote, optional extra. */
    function Kpi({ value, label, note, color, extra }) {
      return h(
        'div',
        { className: 'fb-kpi' },
        h('div', { className: 'fb-kpi-value', style: color ? { color } : undefined }, value),
        h('div', { className: 'fb-kpi-label' }, label),
        extra || null,
        note ? h('div', { className: 'fb-kpi-note' }, note) : null,
      )
    }

    /**
     * Agent distribution as a ranked bar list.
     *
     * A donut with nine agents is nine thin slices of pure colour — the worst
     * possible way to tell agents apart. Rows give every agent a mark and a
     * bar: the shape says who, the bar says how much, and the hue only
     * repeats what the shape already said.
     */
    function AgentBars({ rows, total, empty }) {
      if (rows.length === 0) return h('div', { className: 'fb-agent-bar-empty' }, empty ?? '没有数据')
      const max = Math.max(...rows.map((row) => row.value))
      return h(
        'div',
        { className: 'fb-agent-bars' },
        rows.map((row) =>
          h(
            'div',
            { className: 'fb-agent-bar', key: row.key, title: `${row.label} · ${row.value} 个会话` },
            h(AgentGlyph, { tool: row.key, size: 13, color: row.color }),
            h('span', { className: 'fb-agent-bar-name' }, row.label),
            h(
              'span',
              { className: 'fb-agent-bar-track' },
              h('i', {
                style: {
                  width: `${Math.max(4, (row.value / max) * 100)}%`,
                  background: row.color,
                },
              }),
            ),
            h('span', { className: 'fb-agent-bar-count' }, String(row.value)),
            h(
              'span',
              { className: 'fb-agent-bar-pct' },
              `${total ? Math.round((row.value / total) * 100) : 0}%`,
            ),
          ),
        ),
      )
    }

    /**
     * One mark per agent in the current view. Marks only, no numbers: the
     * counts live in the Agent 分布 card right below, and a second set of
     * numbers here would only ever disagree with it.
     */
    function AgentStrip({ rows }) {
      if (!rows || rows.length === 0) return null
      return h(
        'div',
        { className: 'fb-agent-strip', title: '当前筛选下的 agent' },
        rows.map((row) =>
          h(
            'span',
            {
              className: 'fb-agent-strip-item',
              key: row.key,
              title: `${row.label} · ${row.value} 个会话`,
            },
            h(AgentGlyph, { tool: row.key, size: 13, color: row.color }),
          ),
        ),
      )
    }

    /**
     * Right-click menu for a session card.
     *
     * Clamped to the viewport so a card near an edge cannot open a menu half
     * off-screen; Escape or any outside click closes it, like a native menu.
     */
    function ContextMenu({ at, items, onClose }) {
      useEffect(() => {
        const close = () => onClose()
        const onKey = (event) => {
          if (event.key === 'Escape') onClose()
        }
        window.addEventListener('click', close)
        window.addEventListener('resize', close)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('click', close)
          window.removeEventListener('resize', close)
          window.removeEventListener('keydown', onKey)
        }
      }, [onClose])

      const width = 208
      const height = 14 + items.length * 30
      const left = Math.min(at.x, Math.max(8, window.innerWidth - width - 8))
      const top = Math.min(at.y, Math.max(8, window.innerHeight - height - 8))

      return h(
        'div',
        {
          className: 'fb-menu',
          style: { left: `${left}px`, top: `${top}px`, width: `${width}px` },
          role: 'menu',
          onClick: (event) => event.stopPropagation(),
          onContextMenu: (event) => event.preventDefault(),
        },
        items.map((item, index) =>
          item.separator
            ? h('div', { className: 'fb-menu-sep', key: `sep-${index}` })
            : h(
                'button',
                {
                  type: 'button',
                  key: item.label,
                  className: `fb-menu-item${item.danger ? ' fb-menu-danger' : ''}`,
                  role: 'menuitem',
                  onClick: () => {
                    onClose()
                    item.onSelect()
                  },
                },
                h('span', { className: 'fb-menu-icon' }, item.icon ?? ''),
                item.label,
                item.hint ? h('span', { className: 'fb-menu-hint' }, item.hint) : null,
              ),
        ),
      )
    }

    /**
     * Session card: title + relative time on top, agent / workspace tags in
     * the middle, status and context pressure on the footer.
     */
    function SessionCard({ item, onOpen, onMenu, starred, onStar }) {
      const status = STATUS[item.status] || STATUS.idle
      const color = AGENT_COLOR[item.tool] || PALETTE.slate
      const clickable = Boolean(item.sessionId || item.openLabel)
      const ctx = /ctx\s*(\d+)%/.exec(item.detail || '')
      const extra = item.detail
        ? item.detail.replace(/ctx\s*\d+%/, '').replace(/^[·\s]+|[·\s]+$/g, '')
        : ''
      return h(
        'div',
        {
          className: `fb-session${clickable ? ' fb-session-clickable' : ''}`,
          role: clickable ? 'button' : undefined,
          tabIndex: clickable ? 0 : undefined,
          title: item.sessionId
            ? '打开这个会话 · 右键更多操作'
            : item.openLabel
              ? `${item.openLabel} · 右键更多操作`
              : `${item.workspace}（点一下复制路径）· 右键更多操作`,
          onClick: () => onOpen(item),
          onContextMenu: (event) => {
            event.preventDefault()
            onMenu && onMenu(item, event)
          },
          onKeyDown: (event) => {
            if (clickable && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              onOpen(item)
            }
          },
        },
        h(
          'div',
          { className: 'fb-session-top' },
          h('div', { className: 'fb-session-title' }, item.title),
          h(
            'button',
            {
              type: 'button',
              className: `fb-star${starred ? ' fb-star-on' : ''}`,
              title: starred ? '取消标星' : '标星，置顶显示',
              'aria-pressed': starred ? 'true' : 'false',
              onClick: (event) => {
                // Starring must not also open the session behind the card.
                event.stopPropagation()
                onStar(item)
              },
              onKeyDown: (event) => event.stopPropagation(),
            },
            starred ? '★' : '☆',
          ),
          h('div', { className: 'fb-session-time' }, ago(item.lastActivity)),
        ),
        h('div', { className: 'fb-session-date' }, fullDate(item.lastActivity)),
        h(
          'div',
          { className: 'fb-session-tags' },
          h(
            'span',
            { className: 'fb-tag' },
            h(AgentGlyph, { tool: item.tool, size: 11, color }),
            item.tool,
          ),
          h('span', { className: 'fb-tag fb-tag-muted', title: item.workspace }, item.workspace),
        ),
        h(
          'div',
          { className: 'fb-session-foot' },
          h(
            'span',
            {
              className: 'fb-status',
              style: { color: status.color, background: status.soft },
              title: status.hint,
            },
            h(StatusGlyph, { status: item.status, size: 11 }),
            status.label,
          ),
          ctx
            ? (() => {
                // A warning colour that fires at 35% is a colour nobody reads:
                // green until half, amber approaching the limit, red past it.
                const pct = Math.min(100, Number(ctx[1]))
                const tone = pct < 50 ? PALETTE.green : pct < 80 ? PALETTE.amber : PALETTE.red
                return h(
                  'span',
                  { className: 'fb-session-ctx', title: `上下文占用 ${pct}%` },
                  h('span', { className: 'fb-session-ctx-label', style: { color: tone } }, `ctx ${pct}%`),
                  h('span', { className: 'fb-meter' }, h('i', { style: { width: `${pct}%`, background: tone } })),
                )
              })()
            : extra
              ? h('span', { className: 'fb-session-detail' }, extra)
              : null,
        ),
      )
    }

    /** Collapsible band of sessions. */
    function Group({ title, items, color, defaultOpen, onOpen, onMenu, starSet, onStar, hint, recentMs }) {
      const [open, setOpen] = useState(defaultOpen)
      // Opening a band of 137 rows is not readable; start with the recent ones
      // and let the reader ask for the rest rather than dumping history.
      const [showAll, setShowAll] = useState(false)
      if (items.length === 0) return null
      const counts = {}
      for (const item of items) counts[item.tool] = (counts[item.tool] || 0) + 1
      // Which agents are in this band, shown as marks — the same shapes the
      // chips and the bars use, so the eye can match them across the page.
      const breakdown = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([tool, count]) =>
          h(
            'span',
            { className: 'fb-group-mix', key: tool },
            h(AgentGlyph, { tool, size: 10, color: AGENT_COLOR[tool] }),
            `${tool} ${count}`,
          ),
        )
      const cutoff = !recentMs || showAll ? 0 : Date.now() - recentMs
      const opened = open ? items : []
      const shown = cutoff ? opened.filter((item) => item.lastActivity >= cutoff) : opened
      const withheld = opened.length - shown.length
      return h(
        'section',
        { className: 'fb-group' },
        h(
          'button',
          { type: 'button', className: 'fb-group-head', onClick: () => setOpen((value) => !value) },
          h('span', { className: 'fb-caret' }, open ? '▾' : '▸'),
          h('i', { className: 'fb-group-bar', style: { background: color } }),
          h('span', { className: 'fb-group-title' }, title),
          h('span', { className: 'fb-count' }, String(items.length)),
          h(
            'span',
            { className: 'fb-group-hint' },
            hint || h('span', { className: 'fb-group-mix-row' }, breakdown),
          ),
        ),
        open
          ? h(
              'div',
              { className: 'fb-session-grid' },
              shown.map((item) => h(SessionCard, { key: `${item.tool}:${item.key}`, item, onOpen, onMenu, starred: Boolean(starSet && starSet.has(itemKey(item))), onStar })),
            )
          : null,
        withheld > 0
          ? h(
              'button',
              { type: 'button', className: 'fb-more', onClick: () => setShowAll(true) },
              `还有 ${withheld} 条更早的 · 显示全部`,
            )
          : null,
      )
    }

    /**
 * No sessions anywhere. Saying "nothing here" is not enough after a first
 * install: the reader needs to know what was looked for, and whether something
 * exists that the board could still read.
 */
function EmptyState({ board }) {
  const agents = board.agents || []
  const found = agents.filter((agent) => agent.parsed)
  const unreadable = agents.filter((agent) => !agent.parsed)
  const discovery = board.discovery || {}
  const installable = discovery.installableNames || []
  return h(
    'div',
    { className: 'fb-empty' },
    h('div', { className: 'fb-empty-mark' }, h(AgentGlyph, { tool: 'dsh', size: 28 })),
    h('h2', { className: 'fb-empty-title' }, '还没有可显示的会话'),
    h(
      'p',
      { className: 'fb-empty-sub' },
      found.length > 0
        ? `找到了 ${found.length} 个 agent，但还没有它们的会话记录。`
        : '还没有发现任何 agent 的会话记录。',
    ),
    h(
      'div',
      { className: 'fb-empty-facts' },
      h('span', null, `探测 ${agents.length || '—'} 个 agent`),
      unreadable.length > 0 ? h('span', null, `${unreadable.length} 个读不了`) : null,
      installable.length > 0
        ? h('span', { className: 'fb-empty-new' }, `另有 ${installable.length} 个可接入：${installable.join('、')}`)
        : null,
    ),
    h(
      'p',
      { className: 'fb-empty-hint' },
      '启动后会自动扫描一次；装了什么新工具，下次启动就会出现在这里。',
    ),
  )
}

/** Loading placeholder that mirrors the KPI grid shape. */
    function Skeleton() {
      return h(
        'div',
        { className: 'fb-kpis' },
        Array.from({ length: 6 }, (_, index) =>
          h(
            'div',
            { className: 'fb-kpi', key: index },
            h('div', { className: 'fb-skel', style: { width: '48px', height: '18px' } }),
            h('div', { className: 'fb-skel', style: { width: '64px', marginTop: '8px' } }),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ page */

    function FleetPage(props) {
      const ctx = props.ctx
      const state = useBoard()
      const [notice, setNotice] = useState('')
      const [query, setQuery] = useState('')
      const [range, setRange] = useState('all')
      const [statusFilter, setStatusFilter] = useState('all')
      const [toolFilter, setToolFilter] = useState('all')
      const [sort, setSort] = useState('time')
      const [paused, setPaused] = useState(false)
      // Rows removed from the board. Display-only: nothing on disk is touched.
      const [hidden, setHidden] = useState(() => loadHidden())
      const [menu, setMenu] = useState(null)
      const [starred, setStarred] = useState(() => loadStarred())
      const [agentScope, setAgentScope] = useState('d1')
      const board = state.data

      // The poller reads this flag; keeping it in the store means pausing does
      // not need to tear down and rebuild the interval.
      useEffect(() => {
        store.paused = paused
      }, [paused])

      const flash = useCallback((text) => {
        setNotice(text)
        setTimeout(() => setNotice(''), 1800)
      }, [])

      const onOpen = useCallback(
        async (item) => {
          // A DSH session opens inside the host, no terminal involved.
          if (item.sessionId) {
            if (openSession(ctx, item.sessionId)) return
            flash('宿主没有提供会话跳转接口')
            return
          }
          // Tools with their own CLI get a terminal running the resume command.
          if (item.openLabel && item.openId) {
            if (await requestOpen(item)) {
              flash(item.openLabel)
              return
            }
            const copied = await copyText(item.workspace)
            flash(copied ? `${item.tool} 打不开，已复制工作区路径` : `${item.tool} 打不开`)
            return
          }
          const copied = await copyText(item.workspace)
          flash(copied ? `已复制工作区路径：${item.workspace}` : `工作区：${item.workspace}`)
        },
        [ctx, flash],
      )

      const hideItem = useCallback(
        (item) => {
          const next = new Set(hidden)
          next.add(itemKey(item))
          setHidden(next)
          saveHidden(next)
          flash('已从这个看板移除，可在页脚恢复')
        },
        [hidden, flash],
      )

      const toggleStar = useCallback(
        (item) => {
          const key = itemKey(item)
          const next = new Set(starred)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          setStarred(next)
          saveStarred(next)
          flash(next.has(key) ? '已标星，置顶显示' : '已取消标星')
        },
        [starred, flash],
      )

      const restoreHidden = useCallback(() => {
        setHidden(new Set())
        saveHidden(new Set())
        flash('已恢复所有移除的会话')
      }, [flash])

      const openMenu = useCallback((item, event) => {
        setMenu({ item, x: event.clientX, y: event.clientY })
      }, [])

      const menuItems = useMemo(() => {
        if (!menu) return []
        const item = menu.item
        return [
          {
            label: '从看板移除',
            icon: '⌫',
            danger: true,
            hint: '不影响数据',
            onSelect: () => hideItem(item),
          },
          {
            label: starred.has(itemKey(item)) ? '取消标星' : '标星并置顶',
            icon: '★',
            onSelect: () => toggleStar(item),
          },
          { separator: true },
          {
            label: item.sessionId ? '打开会话' : item.openLabel || '复制工作区路径',
            icon: '↗',
            onSelect: () => onOpen(item),
          },
          {
            label: '复制标题',
            icon: '⧉',
            onSelect: async () => {
              const copied = await copyText(item.title)
              flash(copied ? '已复制标题' : item.title)
            },
          },
          ...(hidden.size > 0
            ? [
                { separator: true },
                {
                  label: `恢复已移除的 ${hidden.size} 条`,
                  icon: '↺',
                  onSelect: restoreHidden,
                },
              ]
            : []),
        ]
      }, [menu, hidden, starred, hideItem, restoreHidden, toggleStar, onOpen, flash])

      const filters = { query, range, status: statusFilter, tool: toolFilter }
      const filtered = useMemo(() => {
        if (!board) return []
        return filterItems(board.items, filters).filter((item) => !hidden.has(itemKey(item)))
      }, [board, query, range, statusFilter, toolFilter, hidden])
      const starredItems = useMemo(
        () => filtered.filter((item) => starred.has(itemKey(item))),
        [filtered, starred],
      )
      const restItems = useMemo(
        () => filtered.filter((item) => !starred.has(itemKey(item))),
        [filtered, starred],
      )
      const bands = useMemo(() => band(restItems), [restItems])
      const sortedBands = useMemo(
        () => ({
          attention: sortItems(bands.attention, sort),
          running: sortItems(bands.running, sort),
          ended: sortItems(bands.ended, sort),
          active: sortItems(bands.active, sort),
          older: sortItems(bands.older, sort),
        }),
        [bands, sort],
      )

      const agentWindow = AGENT_SCOPES.find((entry) => entry.key === agentScope) ?? AGENT_SCOPES[0]
      const agentItems = useMemo(() => {
        if (agentWindow.ms === Infinity) return filtered
        const floor = Date.now() - agentWindow.ms
        return filtered.filter((item) => item.lastActivity >= floor)
      }, [filtered, agentWindow])
      const tools = useMemo(() => toolBreakdown(agentItems), [agentItems])
      const statuses = useMemo(() => statusBreakdown(filtered), [filtered])
      // Widen the heatmap just enough to cover the oldest visible session, so
      // the grid is never half empty and never invents history that is not there.
      const heatWeeks = useMemo(() => {
        if (filtered.length === 0) return 4
        let earliest = Infinity
        for (const item of filtered) earliest = Math.min(earliest, item.lastActivity)
        const weeks = Math.ceil((Date.now() - earliest) / (7 * DAY)) + 1
        return Math.min(10, Math.max(4, weeks))
      }, [filtered])
      const heat = useMemo(() => activityHeatmap(filtered, heatWeeks), [filtered, heatWeeks])
      const heatToday = useMemo(() => {
        const today = dayStart(Date.now())
        return filtered.filter((item) => dayStart(item.lastActivity) === today).length
      }, [filtered])
      const heatWeek = useMemo(
        () => filtered.filter((item) => item.lastActivity >= Date.now() - 7 * DAY).length,
        [filtered],
      )

      const running = board ? board.running : 0
      const attention = board ? board.attention : 0
      // Counted from the rows on screen, not from the host aggregate, so the
      // header and the bands can never disagree.
      const doneCount = filtered.filter((item) => item.status === 'done').length
      const failedCount = filtered.filter((item) => item.status === 'failed').length
      const attentionCount = filtered.filter((item) => item.status === 'needs-you').length
      const runningCount = filtered.filter((item) => item.status === 'running').length
      // "Connected" means it yielded rows: an empty store is not a failure, and
      // counting unreadable agents in the denominator would misread as broken.
      const activeTools = board ? new Set(board.items.map((item) => item.tool)).size : 0
      const totalTools = board ? (board.sources || []).length : 0
      const lastSeen = board && board.items.length ? board.items[0].lastActivity : 0

      const filtersActive = query || range !== 'all' || statusFilter !== 'all' || toolFilter !== 'all'
      // Facet counts: each dimension is counted with the *other* one released,
      // so the chips keep showing the real split while you toggle them.
      // Counting inside the current selection would zero out every other chip.
      const statusCounts = useMemo(() => {
        const counts = new Map()
        const source = board ? filterItems(board.items, { ...filters, status: 'all' }) : []
        for (const item of source) counts.set(item.status, (counts.get(item.status) || 0) + 1)
        return counts
      }, [board, query, range, toolFilter])
      const toolCounts = useMemo(() => {
        const counts = new Map()
        const source = board ? filterItems(board.items, { ...filters, tool: 'all' }) : []
        for (const item of source) counts.set(item.tool, (counts.get(item.tool) || 0) + 1)
        return counts
      }, [board, query, range, statusFilter])
      // How many sessions the "全部 agent" chip would select.
      const agentTotal = useMemo(() => {
        if (!board) return 0
        return filterItems(board.items, { ...filters, tool: 'all' }).length
      }, [board, query, range, statusFilter])

      const resetFilters = useCallback(() => {
        setQuery('')
        setRange('all')
        setStatusFilter('all')
        setToolFilter('all')
      }, [])

      return h(
        'div',
        { className: 'fb-page' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'fb-head' },
          h(
            'div',
            null,
            h(
              'div',
              { className: 'fb-title' },
              h('h1', { className: 'fb-h1' }, 'Agent 空管中心'),
              h(
                'span',
                { className: 'fb-badge' },
                h('i', { className: 'fb-badge-dot' }),
                '本地推断 · 零 token',
              ),
            ),
            h(
              'p',
              { className: 'fb-sub' },
              paused ? '已暂停刷新 · 页面内容停在那一刻' : '本机所有 agent 的会话 · 每 5 秒自动刷新',
            ),
          ),
          h(
            'div',
            { className: 'fb-head-tools' },
            h(
              'span',
              { className: 'fb-live' },
              h('i', { className: 'fb-live-dot fb-live-dot-paused', style: paused ? { background: STATUS['needs-you'].color } : undefined }),
              `更新于 ${clockTime(state.at)}`,
            ),
            h(Segmented, { options: RANGES, value: range, onChange: setRange }),
            h(
              'button',
              {
                type: 'button',
                className: `fb-btn${paused ? ' fb-btn-on' : ''}`,
                title: paused ? '恢复自动刷新' : '暂停自动刷新（截图、演示、专注时用）',
                onClick: () => setPaused((value) => !value),
              },
              paused ? '▶' : '⏸',
              paused ? '继续' : '暂停',
            ),
            h(
              'button',
              { type: 'button', className: 'fb-btn', onClick: () => refresh() },
              h(RefreshIcon, null),
              '刷新',
            ),
          ),
        ),

        menu ? h(ContextMenu, { at: { x: menu.x, y: menu.y }, items: menuItems, onClose: () => setMenu(null) }) : null,

        state.error && !board
          ? h('div', { className: 'fb-error' }, `读取失败：${state.error}`)
          : null,

        !board
          ? h(Skeleton, null)
          : h(
              'div',
              { className: 'fb-body' },
              h(
                'div',
                { className: 'fb-kpis' },
                h(Kpi, { value: String(attentionCount), label: '要你处理', color: STATUS['needs-you'].color, note: '等你拍板或需要重试' }),
                h(Kpi, { value: String(runningCount), label: '在跑', color: STATUS.running.color, note: '正在推进的会话' }),
                h(Kpi, { value: String(failedCount), label: '失败', color: STATUS.failed.color, note: '最近失败的会话' }),
              ),
              h(
                'div',
                { className: 'fb-kpi-note' },
                `完成 ${doneCount} · 本机 ${board.total || board.items.length} · 接入 ${activeTools}/${totalTools}`,
              ),            h(
                'div',
                { className: 'fb-charts' },
                h(
                  'div',
                  { className: 'fb-card' },
                  h(
                    'div',
                    { className: 'fb-card-head' },
                    h('span', { className: 'fb-card-title' }, '活跃度'),
                    h('span', { className: 'fb-card-meta' }, `近 ${heatWeeks} 周`),
                  ),
                  h(
                    'div',
                    { className: 'fb-heat-wrap' },
                    h(
                      'div',
                      { className: 'fb-heat' },
                      h(
                        'div',
                        { className: 'fb-heat-days' },
                        h('span', null, '日'),
                        h('span', null, '一'),
                        h('span', null, '二'),
                        h('span', null, '三'),
                        h('span', null, '四'),
                        h('span', null, '五'),
                        h('span', null, '六'),
                      ),
                      h(
                        'div',
                        { className: 'fb-heat-grid' },
                        h(
                          'div',
                          { className: 'fb-heat-labels' },
                          heat.columns.map((column, index) =>
                            h('span', { className: 'fb-heat-col-label', key: `label-${index}` }, column.label),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'fb-heat-cols' },
                          heat.columns.map((column, index) =>
                            h(
                              'div',
                              { className: 'fb-heat-col', key: `col-${index}` },
                              column.cells.map((cell, row) =>
                                h('i', {
                                  key: `cell-${index}-${row}`,
                                  className: 'fb-heat-cell',
                                  style: {
                                    background: cell.count < 0 ? 'transparent' : heatColor(cell.count, heat.max),
                                  },
                                  title:
                                    cell.count < 0
                                      ? ''
                                      : `${fullDate(cell.time)} · ${cell.count} 个会话`,
                                }),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'fb-heat-side' },
                      h(
                        'div',
                        { className: 'fb-heat-stat' },
                        h('b', null, String(heatToday)),
                        '今天动过',
                      ),
                      h(
                        'div',
                        { className: 'fb-heat-stat' },
                        h('b', null, String(heatWeek)),
                        '近 7 天动过',
                      ),
                      h(
                        'div',
                        { className: 'fb-heat-stat' },
                        h('b', null, String(heat.busiest.count)),
                        `个 · 最忙 ${heat.busiest.count ? dayLabel(heat.busiest.time) : '—'}`,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'fb-heat-legend' },
                    h('span', null, '少'),
                    [HEAT_EMPTY, ...HEAT_SCALE].map((color) =>
                      h('i', { key: color, style: { background: color } }),
                    ),
                    h('span', null, '多'),
                  ),
                ),
                h(
                  'div',
                  { className: 'fb-card' },
                  h(
                    'div',
                    { className: 'fb-card-head' },
                    h('span', { className: 'fb-card-title' }, 'Agent 分布'),
                    h(
                      'span',
                      { className: 'fb-card-meta' },
                      agentItems.length === filtered.length
                        ? `${agentItems.length} 个会话`
                        : `${agentItems.length} / ${filtered.length} 个会话`,
                    ),
                    h(Segmented, { options: AGENT_SCOPES, value: agentScope, onChange: setAgentScope }),
                  ),
                  h(AgentBars, {
                    rows: tools,
                    total: agentItems.length,
                    empty: agentScope === 'all' ? '没有数据' : `${agentWindow.label}没有会话，切到别的窗口或点「全部」`,
                  }),
                ),
              ),

              h(
                'div',
                { className: 'fb-card fb-statusbar' },
                h(
                  'div',
                  { className: 'fb-card-head' },
                  h('span', { className: 'fb-card-title' }, '状态分布'),
                  h('span', { className: 'fb-card-meta' }, '全部筛选结果'),
                ),
                h(
                  'div',
                  { className: 'fb-statusbar-track' },
                  statuses.length === 0
                    ? null
                    : statuses.map((status) =>
                        h('i', {
                          key: status.key,
                          className: 'fb-statusbar-seg',
                          style: {
                            width: `${(status.value / Math.max(1, filtered.length)) * 100}%`,
                            background: status.color,
                          },
                          title: `${status.label} ${status.value}`,
                        }),
                      ),
                ),
                h(
                  'div',
                  { className: 'fb-statusbar-legend' },
                  statuses.length === 0
                    ? h('span', null, '没有数据')
                    : statuses.map((status) =>
                        h(
                          'span',
                          { className: 'fb-statusbar-item', key: status.key },
                          h(StatusGlyph, { status: status.key, size: 12, color: status.color }),
                          `${status.label} ${status.value}`,
                        ),
                      ),
                ),
              ),

              h(
                'div',
                { className: 'fb-list-head' },
                h('span', { className: 'fb-list-title' }, '会话'),
                h('span', { className: 'fb-count' }, String(filtered.length)),
                h(
                  'span',
                  { className: 'fb-list-meta' },
                  board.total > board.items.length
                    ? `本机共 ${board.total} 个会话，只取最近 ${board.items.length} 个`
                    : `本机共 ${board.items.length} 个会话`,
                ),
                h(
                  'div',
                  { className: 'fb-list-tools' },
                  h(
                    'label',
                    { className: 'fb-search' },
                    h(SearchIcon, null),
                    h('input', {
                      value: query,
                      placeholder: '搜索标题、工作区…',
                      onChange: (event) => setQuery(event.target.value),
                    }),
                  ),
                  h(Segmented, { options: SORTS, value: sort, onChange: setSort }),
                ),
              ),

              h(
                'div',
                { className: 'fb-filters' },
                // Two rows, one per dimension. The agent row grows with the
                // machine and the status row never has more than four chips:
                // sharing a line meant the states drifted right and the
                // divider between the two groups vanished on the first wrap.
                h(
                  'div',
                  { className: 'fb-filter-row' },
                  h('span', { className: 'fb-filter-label' }, 'agent'),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: `fb-chip${toolFilter === 'all' ? ' fb-chip-active' : ''}`,
                      title: '显示所有 agent',
                      onClick: () => setToolFilter('all'),
                    },
                    '全部',
                    h('span', { className: 'fb-chip-count' }, String(agentTotal)),
                  ),
                  // A source that is readable but holds nothing (an empty store)
                  // earns no chip: showing "claude 0" reads like a broken agent.
                  (board.sources || [])
                    .filter((source) => source.available && (toolCounts.get(source.tool) || 0) > 0)
                    .map((source) =>
                    h(
                      'button',
                      {
                        key: source.tool,
                        type: 'button',
                        className: `fb-chip${toolFilter === source.tool ? ' fb-chip-active' : ''}`,
                        title: `${toolCounts.get(source.tool) || 0} 个会话 · 再点一次取消筛选`,
                        // Clicking the selected chip again releases it: a filter
                        // you cannot take off is a trap.
                        onClick: () => setToolFilter((current) => toggleFilter(current, source.tool)),
                      },
                      h(AgentGlyph, {
                        tool: source.tool,
                        size: 12,
                        color: AGENT_COLOR[source.tool],
                      }),
                      source.tool,
                      h('span', { className: 'fb-chip-count' }, String(toolCounts.get(source.tool) || 0)),
                    ),
                  ),
                  (() => {
                    // Agents found on this machine that no parser reads yet: shown
                    // so the chip row never passes for a complete inventory.
                    const unparsed = (board.agents || []).filter((agent) => !agent.parsed)
                    if (unparsed.length === 0) return null
                    return [
                      h('span', { key: 'unparsed-sep', className: 'fb-chip-sep' }),
                      ...unparsed.map((agent) =>
                        h(
                          'span',
                          {
                            key: `unparsed-${agent.tool}`,
                            className: 'fb-chip fb-chip-off fb-chip-muted',
                            title: agent.reason
                              ? `${agent.path} — ${agent.reason}`
                              : `检测到 ${agent.path}，但还没有解析器`,
                          },
                          h(AgentGlyph, { tool: agent.tool, size: 12 }),
                          agent.tool,
                          h('span', { className: 'fb-chip-count' }, agent.reason?.includes('加密') ? '已加密' : '未接入'),
                        ),
                      ),
                    ]
                  })(),
                ),
                h(
                  'div',
                  { className: 'fb-filter-row' },
                  h('span', { className: 'fb-filter-label' }, '状态'),
                  // Only the states worth filtering on. 刚停 and 无动静 are the
                  // catch-all buckets: they say "nothing happened lately", and
                  // filtering by them just reproduces the 更早 band.
                  FILTERABLE_STATUSES.filter((status) => statusCounts.has(status)).map((status) =>
                    h(
                      'button',
                      {
                        key: status,
                        type: 'button',
                        className: `fb-chip${statusFilter === status ? ' fb-chip-active' : ''}`,
                        title: `${STATUS[status].hint} · 再点一次取消筛选`,
                        onClick: () => setStatusFilter((current) => toggleFilter(current, status)),
                      },
                      h(StatusGlyph, { status, size: 12, color: STATUS[status].color }),
                      STATUS[status].label,
                      h('span', { className: 'fb-chip-count' }, String(statusCounts.get(status))),
                    ),
                  ),
                  filtersActive
                    ? h(
                        'button',
                        { type: 'button', className: 'fb-chip fb-chip-reset', onClick: resetFilters },
                        '清空筛选',
                      )
                    : null,
                ),
              ),

              board.items.length === 0
                ? h(EmptyState, { board })
                : null,

              filtered.length === 0
                ? h('div', { className: 'fb-clear' }, '当前筛选下没有会话')
                : null,

              bands.attention.length === 0 && filtered.length > 0
                ? h(
                    'div',
                    { className: 'fb-clear' },
                    h(CheckIcon, null),
                    '没有需要你处理的',
                  )
                : null,

              h(Group, {
                title: '标星',
                items: sortItems(starredItems, sort),
                color: '#d9a520',
                defaultOpen: true,
                onOpen,
                onMenu: openMenu,
                starSet: starred,
                onStar: toggleStar,
                hint: '你标过的',
              }),
              h(Group, {
                title: '要你处理',
                items: sortedBands.attention,
                color: STATUS['needs-you'].color,
                defaultOpen: true,
                onMenu: openMenu,
                starSet: starred,
                onStar: toggleStar,
                onOpen,
              }),
              h(Group, {
                title: '正在跑',
                items: sortedBands.running,
                color: STATUS.running.color,
                defaultOpen: true,
                onMenu: openMenu,
                starSet: starred,
                onStar: toggleStar,
                onOpen,
              }),
              h(Group, {
                title: '刚结束',
                items: sortedBands.ended,
                color: STATUS.done.color,
                defaultOpen: false,
                onMenu: openMenu,
                starSet: starred,
                onStar: toggleStar,
                onOpen,
                hint: '24 小时内有终态 · 点开查看',
              }),
              h(Group, {
                title: '刚动过',
                items: sortedBands.active,
                color: STATUS.recent.color,
                defaultOpen: true,
                onMenu: openMenu,
                starSet: starred,
                onStar: toggleStar,
                onOpen,
                hint: '半小时内动过，没说结束',
              }),
              h(Group, {
                title: '更早',
                items: sortedBands.older,
                color: STATUS.idle.color,
                defaultOpen: false,
                onMenu: openMenu,
                starSet: starred,
                onStar: toggleStar,
                onOpen,
                // A collapsed band of history is fine; expanding it to 137 rows
                // is not, so it opens to the last week first.
                recentMs: 7 * DAY,
                hint: '近 7 天 · 点开查看',
              }),
            ),

        h(
          'footer',
          { className: 'fb-foot' },
          h('span', null, '点 DSH 行打开会话 · 点其它行复制工作区路径'),
          h(
            'span',
            { className: 'fb-hidden-note' },
            hidden.size > 0
              ? h(
                  'span',
                  null,
                  `已移除 ${hidden.size} 条`,
                  h('button', { type: 'button', className: 'fb-hidden-restore', onClick: restoreHidden }, '恢复'),
                )
              : h('span', null, `最后活动 ${ago(lastSeen)}`),
          ),
        ),

        notice ? h('div', { className: 'fb-toast' }, notice) : null,
      )
    }

    /* ------------------------------------------------------------------ css */

    const CSS = `
.fb-page::-webkit-scrollbar{width:10px}
.fb-page::-webkit-scrollbar-thumb{background:var(--fb-line);border-radius:8px;border:3px solid transparent;background-clip:content-box}
.fb-page::-webkit-scrollbar-thumb:hover{background:var(--fb-text-4);background-clip:content-box}
.fb-page{scrollbar-width:thin;scrollbar-color:var(--fb-line) transparent}
.fb-page{box-sizing:border-box;height:100%;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;--fb-line:var(--dsw-alias-border-l1,#e8ebf0);--fb-line-soft:var(--dsw-alias-border-l2,#eff1f4);--fb-surface:var(--dsw-alias-card-fill,#fff);--fb-fill:var(--dsw-alias-interactive-bg-hover,#f3f5f8);--fb-elevated:var(--dsw-alias-button-elevated-fill,#f4f5f7);--fb-hover:var(--dsw-alias-interactive-bg-hover,#f3f5f8);--fb-text:var(--dsw-alias-label-primary,#1f2328);--fb-text-2:var(--dsw-alias-label-secondary,#57606a);--fb-text-3:var(--dsw-alias-label-tertiary,#8b949e);--fb-text-4:var(--dsw-alias-label-quaternary,#a8b0ba);--fb-r-xs:var(--dsw-radius-xs,4px);--fb-r-sm:var(--dsw-radius-sm,8px);--fb-r-md:var(--dsw-radius-md,12px);--fb-r-lg:var(--dsw-radius-lg,16px);max-width:1180px;margin:0 auto;padding:18px 22px 36px;color:var(--fb-text);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.fb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.fb-title{display:flex;align-items:center;gap:8px}
.fb-h1{margin:0;font-size:16px;font-weight:650;letter-spacing:.01em}
.fb-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--fb-line);background:var(--fb-fill);color:var(--fb-text-3)}
.fb-badge-dot{width:6px;height:6px;border-radius:50%;background:#2f9e6f;display:inline-block}
.fb-sub{margin:4px 0 0;font-size:12px;color:var(--fb-text-3)}
.fb-head-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-left:auto}
.fb-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--fb-text-3);font-variant-numeric:tabular-nums}
.fb-live-dot{width:6px;height:6px;border-radius:50%;background:#2f9e6f;display:inline-block;animation:fb-pulse 1.8s ease-in-out infinite}
@keyframes fb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.75)}}
.fb-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--fb-line);background:var(--fb-elevated);color:var(--fb-text-2);border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit;transition:background .15s,color .15s}
.fb-btn:hover{background:var(--fb-hover);color:var(--fb-text)}
.fb-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--fb-line);border-radius:var(--fb-r-sm);background:var(--fb-fill)}
.fb-seg-item{border:none;background:transparent;color:var(--fb-text-3);font-family:inherit;font-size:11.5px;padding:3px 10px;border-radius:var(--fb-r-xs);cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
.fb-seg-item:hover{color:var(--fb-text)}
.fb-seg-item-active{background:var(--fb-text);color:var(--fb-surface)}
.fb-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.fb-kpi{border:1px solid var(--fb-line);border-radius:var(--fb-r-md);padding:12px 14px;background:var(--fb-fill)}
.fb-kpi-value{font-size:22px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.fb-kpi-label{margin-top:3px;font-size:11.5px;color:var(--fb-text-2)}
.fb-kpi-note{margin-top:1px;font-size:10.5px;color:var(--fb-text-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Always one row: the two charts share the width instead of stacking. They
   shrink by stepping their internals down (heat cells, name column) rather than
   by moving to separate lines — a dashboard that reflows into a column loses
   the at-a-glance comparison it exists for. */
.fb-charts{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
.fb-charts>.fb-card{min-width:0}
@media (max-width:980px){
.fb-charts{gap:10px}
.fb-heat-cell{width:12px;height:12px}
.fb-agent-bar-name{width:62px}
.fb-card{padding:12px}
}
@media (max-width:840px){
.fb-heat-cell{width:10px;height:10px}
.fb-heat-grid{gap:3px}
.fb-heat{gap:4px}
.fb-agent-bar-name{width:52px}
.fb-agent-bar-pct{display:none}
}
@media (max-width:720px){
.fb-heat-cell{width:8px;height:8px}
.fb-agent-bar{gap:6px}
.fb-agent-bar-name{width:44px;font-size:11px}
}
.fb-card{border:1px solid var(--fb-line);border-radius:var(--fb-r-md);background:var(--fb-surface);padding:14px 16px}
.fb-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px;flex-wrap:wrap}
.fb-card-title{font-size:13px;font-weight:600}
.fb-card-meta{font-size:11px;color:var(--fb-text-4)}
.fb-heat-wrap{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.fb-heat{display:flex;gap:6px;align-items:flex-start;flex:none}
.fb-heat-days{display:grid;grid-template-rows:repeat(7,14px);gap:4px;padding-top:16px;font-size:9.5px;color:var(--fb-text-4);line-height:14px;text-align:right}
.fb-heat-grid{display:flex;flex-direction:column;gap:4px}
.fb-heat-labels{display:flex;gap:4px;height:12px}
.fb-heat-col-label{width:14px;font-size:9.5px;color:var(--fb-text-4);line-height:12px;white-space:nowrap;text-align:center}
.fb-heat-cols{display:flex;gap:4px}
.fb-heat-col{display:flex;flex-direction:column;gap:4px}
.fb-heat-cell{width:14px;height:14px;border-radius:3px;display:block}
.fb-heat-side{margin-left:auto;display:flex;flex-direction:column;gap:9px;flex:none}
.fb-heat-stat{display:flex;align-items:baseline;gap:7px;font-size:11.5px;color:var(--fb-text-3)}
.fb-heat-stat b{font-size:15px;font-weight:650;color:var(--fb-text);font-variant-numeric:tabular-nums}
.fb-heat-legend{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fb-text-4);margin-top:14px}
.fb-heat-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.fb-glyph{display:inline-block;flex:none;color:var(--fb-agent-color,currentColor)}
/* Lined marks for the states; the agent logos are filled, so the two
   dimensions never read as the same kind of thing. */
.fb-status-glyph{display:inline-block;flex:none;color:var(--fb-status-color,currentColor)}
.fb-agent-bars{display:flex;flex-direction:column;gap:8px}
.fb-agent-bar{display:flex;align-items:center;gap:9px;font-size:12px}
.fb-agent-bar-name{width:76px;flex:none;color:var(--fb-text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb-agent-bar-track{flex:1;min-width:48px;height:7px;border-radius:999px;background:var(--fb-line-soft);overflow:hidden}
.fb-agent-bar-track i{display:block;height:100%;border-radius:999px}
.fb-agent-bar-count{width:32px;flex:none;text-align:right;color:var(--fb-text-3);font-size:11px;font-variant-numeric:tabular-nums}
.fb-agent-bar-pct{width:34px;flex:none;text-align:right;color:var(--fb-text-4);font-size:11px;font-variant-numeric:tabular-nums}
.fb-agent-bar-empty{font-size:12px;color:var(--fb-text-4)}
.fb-agent-strip{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:7px}
.fb-agent-strip-item{display:inline-flex;align-items:center;flex:none}
.fb-statusbar{margin-bottom:4px}
.fb-statusbar-track{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--fb-line-soft)}
.fb-statusbar-seg{height:100%;display:block}
.fb-statusbar-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:11px;font-size:11.5px;color:var(--fb-text-3)}
.fb-statusbar-item{display:inline-flex;align-items:center;gap:6px}
.fb-list-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:16px 0 10px}
.fb-list-title{font-size:14px;font-weight:650}
.fb-list-meta{font-size:11px;color:var(--fb-text-4)}
.fb-list-tools{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fb-search{display:flex;align-items:center;gap:6px;border:1px solid var(--fb-line);border-radius:var(--fb-r-sm);padding:4px 10px;background:var(--fb-surface);min-width:190px;color:var(--fb-text-4)}
.fb-search:focus-within{border-color:var(--fb-blue,#4c7cf3)}
.fb-search input{border:none;outline:none;background:transparent;font-family:inherit;font-size:12px;color:var(--fb-text);width:100%}
.fb-search input::placeholder{color:var(--fb-text-4)}
.fb-filters{display:flex;flex-direction:column;gap:7px;margin-bottom:12px}
.fb-filter-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
/* Fixed label width: the chips of both rows start at the same x, so the two
   dimensions line up instead of stepping in and out. */
.fb-filter-label{width:32px;flex:none;font-size:10.5px;color:var(--fb-text-4);user-select:none;white-space:nowrap}
.fb-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 10px;border-radius:var(--fb-r-sm);border:1px solid var(--fb-line);background:var(--fb-surface);color:var(--fb-text-2);cursor:pointer;font-family:inherit;transition:background .15s,color .15s,border-color .15s}
.fb-chip:hover{background:var(--fb-hover)}
.fb-chip-active{background:var(--fb-text);border-color:var(--fb-text);color:var(--fb-surface)}
.fb-chip-active:hover{background:var(--fb-text);opacity:.9}
.fb-chip-active .fb-glyph{color:inherit}
.fb-chip-active .fb-status-glyph{color:inherit}
.fb-chip-off{color:var(--fb-text-4);border-style:dashed;cursor:default}
.fb-chip-off:hover{background:transparent}
.fb-chip-muted{opacity:.75;cursor:default}
.fb-chip-count{font-size:10.5px;color:var(--fb-text-4);font-variant-numeric:tabular-nums}
.fb-chip-sep{width:1px;height:15px;background:var(--fb-line);margin:0 4px;flex:none}
.fb-chip-active .fb-chip-count{color:rgba(255,255,255,.72)}
.fb-chip-reset{border-style:dashed;color:var(--fb-text-3);margin-left:auto}
.fb-clear{display:flex;align-items:center;gap:8px;padding:10px 12px;margin-bottom:10px;border:1px solid rgba(47,158,111,.25);background:rgba(47,158,111,.07);border-radius:10px;font-size:12px;color:#2f9e6f}
.fb-group{margin-bottom:8px}
.fb-group-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:inherit;font-family:inherit;font-size:12px;font-weight:600;padding:8px 4px;cursor:pointer;text-align:left}
.fb-caret{width:9px;color:var(--fb-text-4);font-size:9px}
.fb-group-bar{width:3px;height:12px;border-radius:2px;display:inline-block}
.fb-group-title{color:var(--fb-text)}
.fb-count{font-size:11px;font-weight:600;color:var(--fb-text-3);background:var(--fb-fill);border:1px solid var(--fb-line);border-radius:999px;padding:0 7px;font-variant-numeric:tabular-nums}
.fb-group-hint{margin-left:auto;font-size:11px;font-weight:400;color:var(--fb-text-4)}
.fb-group-mix-row{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap}
.fb-group-mix{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.fb-session-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:9px}
.fb-session{display:flex;flex-direction:column;gap:7px;border:1px solid var(--fb-line);border-radius:var(--fb-r-md);background:var(--fb-surface);padding:12px 13px;transition:border-color .15s,box-shadow .15s}
.fb-session-clickable{cursor:pointer}
.fb-session-clickable:hover{border-color:#c3d0f6;box-shadow:0 4px 14px rgba(20,28,45,.07)}
.fb-session-top{display:flex;align-items:flex-start;gap:10px}
.fb-session-title{flex:1;min-width:0;font-size:12.5px;font-weight:600;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.fb-session-time{flex:none;font-size:11px;color:var(--fb-text-4);font-variant-numeric:tabular-nums;white-space:nowrap;padding-top:1px}
.fb-session-date{font-size:10.5px;color:var(--fb-text-4);font-variant-numeric:tabular-nums;margin-top:-3px}
.fb-session-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.fb-tag{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--fb-text-2);background:var(--fb-fill);border:1px solid var(--fb-line);border-radius:var(--fb-r-xs);padding:1px 7px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb-tag-muted{color:var(--fb-text-3)}
.fb-session-foot{margin-top:auto;padding-top:9px;border-top:1px solid var(--fb-line-soft);display:flex;align-items:center;gap:10px}
.fb-session-ctx{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--fb-text-3);font-variant-numeric:tabular-nums}
.fb-session-detail{margin-left:auto;font-size:10.5px;color:var(--fb-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.fb-meter{width:52px;height:4px;border-radius:999px;background:var(--fb-line-soft);overflow:hidden;flex:none;display:inline-block}
.fb-meter i{display:block;height:100%;border-radius:999px;background:#d98324}
.fb-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;white-space:nowrap}
/* Star: quiet until hovered, gold once set — a deliberate signal, so it stays visible. */
.fb-star{border:0;background:none;padding:0 2px;margin-left:auto;font-size:12px;line-height:1;color:var(--fb-text-4);cursor:pointer;opacity:0;transition:opacity .12s ease,color .12s ease;font-family:inherit}
.fb-session:hover .fb-star,.fb-star-on{opacity:1}
.fb-star:hover{color:#d9a520}
.fb-star-on{color:#d9a520}
/* The tail of a long band: one quiet row instead of a wall of history. */
.fb-more{display:block;width:100%;margin-top:8px;padding:9px;border:1px dashed var(--fb-line);border-radius:var(--fb-r-sm);background:none;color:var(--fb-text-3);font-size:11.5px;cursor:pointer;font-family:inherit}
.fb-more:hover{background:var(--fb-fill);color:var(--fb-text-2)}
/* Right-click menu: floats above the board, clamped to the viewport. */
.fb-menu{position:fixed;z-index:60;padding:6px;background:var(--fb-surface);border:1px solid var(--fb-line);border-radius:var(--fb-r-sm);box-shadow:0 12px 32px rgba(15,23,42,.18);display:flex;flex-direction:column;gap:1px}
.fb-menu-item{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:0;border-radius:var(--fb-r-xs);background:none;color:var(--fb-text);font-size:12px;text-align:left;cursor:pointer;font-family:inherit}
.fb-menu-item:hover{background:var(--fb-fill)}
.fb-menu-danger{color:#c0392b}
.fb-menu-danger:hover{background:rgba(217,83,79,.1)}
.fb-menu-icon{width:14px;display:inline-flex;justify-content:center;color:var(--fb-text-3);font-size:11px}
.fb-menu-hint{margin-left:auto;color:var(--fb-text-4);font-size:10px}
.fb-menu-sep{height:1px;margin:4px 6px;background:var(--fb-line-soft)}
.fb-hidden-note{gap:8px}
.fb-hidden-restore{border:0;background:none;color:var(--fb-text-3);font-size:11px;text-decoration:underline;cursor:pointer;padding:0 0 0 8px;font-family:inherit}
.fb-hidden-restore:hover{color:var(--fb-text)}
/* One line of inventory under the action KPIs, instead of four more cards. */
.fb-kpi-note{margin:-2px 0 14px;font-size:11px;color:var(--fb-text-4)}
/* A fault worth acting on, placed above the work queue. */
.fb-alert{display:flex;align-items:center;gap:9px;padding:9px 12px;margin:0 0 12px;border:1px solid rgba(217,131,36,.35);background:rgba(217,131,36,.08);border-radius:var(--fb-r-sm);font-size:11.5px;color:var(--fb-text-2)}
.fb-alert-mark{width:16px;height:16px;border-radius:50%;display:grid;place-items:center;background:var(--fb-amber,rgba(217,131,36,.9));color:#fff;font-size:10px;font-weight:700;flex:none}
.fb-btn-on{background:var(--fb-fill);color:var(--fb-text)}
.fb-live-dot-paused{background:var(--fb-text-4)}
.fb-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:56px 24px;margin:8px 0 24px;border:1px dashed var(--fb-line);border-radius:var(--fb-r-md);text-align:center}
.fb-empty-mark{width:52px;height:52px;border-radius:50%;display:grid;place-items:center;background:var(--fb-fill);color:var(--fb-text-3);margin-bottom:2px}
.fb-empty-title{margin:0;font-size:14px;font-weight:600;color:var(--fb-text)}
.fb-empty-sub{margin:0;font-size:12px;color:var(--fb-text-3);max-width:420px;line-height:1.6}
.fb-empty-facts{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;font-size:11px;color:var(--fb-text-4);margin:6px 0 10px}
.fb-empty-hint{margin:2px 0 0;font-size:11px;color:var(--fb-text-4)}
.fb-empty-new{color:var(--fb-text-2)}
.fb-skel{height:11px;border-radius:5px;background:linear-gradient(90deg,#eef0f3,#f7f8fa,#eef0f3);background-size:200% 100%;animation:fb-sh 1.4s linear infinite}
@keyframes fb-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
.fb-empty,.fb-error{padding:14px 2px;font-size:12px;color:var(--fb-text-3)}
.fb-error{color:var(--dsw-alias-label-error,#c0392b)}
.fb-foot{margin-top:18px;padding-top:12px;border-top:1px solid var(--fb-line-soft);font-size:10.5px;color:var(--fb-text-4);display:flex;gap:16px;flex-wrap:wrap}
.fb-toast{position:fixed;right:20px;bottom:20px;z-index:40;background:#1f2328;color:#fff;font-size:12px;padding:8px 14px;border-radius:9px;box-shadow:0 8px 24px rgba(16,22,34,.18)}
`

    /* ---------------------------------------------------------------- wiring */

    const inject = []

    function apply(ctx) {
      // Wait for the slot registry inside a scoped inject: a host without it
      // must not keep `apply` from running, and a missing service must not throw.
      ctx.inject(['slots'], (inner) => {
        const slots = inner.slots
        if (!slots || typeof slots.register !== 'function') return
        const page = (props) => h(FleetPage, { ...props, ctx: inner })

        // The sidebar row (beside Plugins / Automations) …
        slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => '空管',
            },
            PanelIcon,
          ),
        )
        // … and the main-column page it addresses.
        slots.inject('main', () =>
          slots.register({ name: 'main', key: PANEL_ID, registrant: PANEL_ID }, page),
        )

        globalThis.__dshFleetBoard = { registered: true, at: Date.now() }
      })
    }

    return {
      name: 'dsh-atc',
      inject,
      apply,
      /** Seams for the offline render check; the host never reads these. */
      __test: { FleetPage, store, refresh, toggleFilter, AGENT_GLYPH, agentGlyph, STATUS_SHAPES, STATUS_ORDER },
    }
  },
})
