// Research Vault mathematics (server-side only: never shipped to the browser). Built-in models are code, versioned
// here and never changed in place (a change = a new version id). Each model states its variables with units,
// assumptions, domain, derivation and status. Verification is labelled for what it is:
//   'derivation'   a written analytical derivation (human-checkable steps)
//   'numeric'      numerical checks of the derivation's claims (finite differences, boundaries, grid search)
//   'formal'       a machine-checked proof: NONE exist here (no Lean/SymPy integration); never claimed
// Empirical status is separate: every built-in model is 'illustrative' until real data validates it.

// ---------- numerics ----------
const fin = (x) => Number.isFinite(x)
export const round = (x, d = 4) => (fin(x) ? Math.round(x * 10 ** d) / 10 ** d : x)
const deriv = (f, x, h = 1e-4 * Math.max(1, Math.abs(x))) => (f(x + h) - f(x - h)) / (2 * h)
const deriv2 = (f, x, h = 1e-3 * Math.max(1, Math.abs(x))) => (f(x + h) - 2 * f(x) + f(x - h)) / (h * h)
function golden(f, lo, hi, iters = 120) {
  const g = (Math.sqrt(5) - 1) / 2
  let a = lo
  let b = hi
  for (let i = 0; i < iters; i++) {
    const c = b - g * (b - a)
    const d = a + g * (b - a)
    if (f(c) > f(d)) b = d
    else a = c
  }
  return (a + b) / 2
}
const grid = (lo, hi, n = 60) => Array.from({ length: n + 1 }, (_, i) => lo + ((hi - lo) * i) / n)
// Standard normal CDF (Zelen & Severo 26.2.17, |error| < 7.5e-8) and its inverse (Acklam, relative error < 1.2e-9).
export function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z))
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2)
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return z >= 0 ? 1 - p : p
}
export function invPhi(p) {
  if (!(p > 0 && p < 1)) return NaN
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) return -invPhi(1 - p)
  const q = p - 0.5
  const r = q * q
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}
// Wilson score interval for a proportion (better than the normal interval at small n).
export function wilson(successes, n, z = 1.96) {
  if (!(n > 0)) return null
  const p = successes / n
  const den = 1 + (z * z) / n
  const mid = (p + (z * z) / (2 * n)) / den
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den
  return { p: round(p), low: round(Math.max(0, mid - half)), high: round(Math.min(1, mid + half)) }
}

// ---------- experiments and belief updating ----------
// Sample size per arm for a two-sided two-proportion z-test (pooled variance under H0).
export function sampleSize({ baseline, effect, alpha = 0.05, power = 0.8 }) {
  const p1 = Number(baseline)
  const p2 = p1 + Number(effect)
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1 && effect !== 0)) return { ok: false, error: 'invalid_rates' }
  const pbar = (p1 + p2) / 2
  const za = invPhi(1 - alpha / 2)
  const zb = invPhi(power)
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2
  return { ok: true, perArm: Math.ceil(n), total: 2 * Math.ceil(n), alpha, power }
}
// Two-proportion analysis with the safeguards the lab requires: no verdict before the planned sample (peeking), the
// frequentist test AND a Bayesian Beta(1,1) posterior, and 'insufficient' instead of a guess.
export function analyzeExperiment({ controlN, controlSuccesses, treatmentN, treatmentSuccesses, plannedSample, alpha = 0.05 }) {
  const n1 = Number(controlN)
  const x1 = Number(controlSuccesses)
  const n2 = Number(treatmentN)
  const x2 = Number(treatmentSuccesses)
  if (![n1, x1, n2, x2].every((v) => Number.isInteger(v) && v >= 0) || x1 > n1 || x2 > n2) return { verdict: 'invalid_data' }
  const planned = Number(plannedSample) > 0 ? Number(plannedSample) : null
  const reached = planned != null && n1 >= planned && n2 >= planned
  if (n1 < 10 || n2 < 10) return { verdict: 'insufficient', reason: 'fewer than 10 per arm', reached }
  const p1 = x1 / n1
  const p2 = x2 / n2
  const pooled = (x1 + x2) / (n1 + n2)
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2))
  const z = se > 0 ? (p2 - p1) / se : 0
  const pValue = 2 * (1 - phi(Math.abs(z)))
  // Beta(1+x, 1+n-x) posteriors; P(treatment > control) by the normal approximation of the difference.
  const post = (x, n) => ({ m: (1 + x) / (2 + n), v: ((1 + x) * (1 + n - x)) / ((2 + n) ** 2 * (3 + n)) })
  const a = post(x1, n1)
  const b = post(x2, n2)
  const probBetter = phi((b.m - a.m) / Math.sqrt(a.v + b.v))
  const significant = pValue < alpha
  const verdict = !planned ? 'no_plan' : !reached ? 'running' : significant ? (p2 > p1 ? 'treatment_better' : 'treatment_worse') : 'no_detectable_difference'
  return { verdict, reached, control: wilson(x1, n1), treatment: wilson(x2, n2), difference: round(p2 - p1), z: round(z, 3), pValue: round(pValue, 4), probTreatmentBetter: round(probBetter, 3), note: reached ? 'Planned sample reached: the test is read once, here.' : 'Planned sample not reached: no verdict (repeated looks inflate false positives).' }
}
// Beta-binomial belief update for a rate (prior from earlier evidence; flat Beta(1,1) when none).
export function updateBelief({ priorSuccesses = 0, priorN = 0, successes, n }) {
  const a = 1 + Number(priorSuccesses) + Number(successes)
  const b = 1 + (Number(priorN) - Number(priorSuccesses)) + (Number(n) - Number(successes))
  if (![a, b].every((v) => v > 0 && fin(v))) return { ok: false, error: 'invalid_data' }
  const mean = a / (a + b)
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)))
  return { ok: true, alpha: a, beta: b, mean: round(mean), low: round(Math.max(0, mean - 1.96 * sd)), high: round(Math.min(1, mean + 1.96 * sd)), approx: 'normal approximation of the Beta posterior' }
}

// ---------- built-in models ----------
const num = (p, k, d) => (fin(Number(p?.[k])) ? Number(p[k]) : d)
export const MODELS = {
  'GS-ECO-001@1': {
    program: 'GS-ECO-001',
    title: 'Diminishing returns to advertising spend (square-root response)',
    question: 'How much should one campaign spend per period, if extra spend brings ever fewer customers?',
    objective: 'Maximize contribution after ad spend',
    expression: 'N(x) = a·√x ;  Π(x) = v·a·√x − x',
    variables: [
      { name: 'x', meaning: 'ad spend in the period', unit: '$' },
      { name: 'a', meaning: 'response scale: customers per √$', unit: 'customers/√$' },
      { name: 'v', meaning: 'contribution per customer (after service costs)', unit: '$/customer' },
      { name: 'B', meaning: 'budget ceiling', unit: '$' },
    ],
    assumptions: ['Customers respond to spend as a·√x (concave, no threshold, no saturation ceiling).', 'v is constant across customers and spend levels.', 'The period is short enough that a and v are stable.', 'Spend in this campaign does not change other channels.'],
    domain: 'x ≥ 0, a > 0, v > 0, B ≥ 0',
    derivation: [
      'Π(x) = v·a·x^(1/2) − x.',
      'Π′(x) = v·a / (2√x) − 1.',
      'Π′(x) = 0 ⇔ √x = v·a/2 ⇔ x* = (v·a/2)².',
      'Π″(x) = −v·a / (4·x^(3/2)) < 0 for x > 0: Π is strictly concave, so x* is the unique global maximum on x > 0.',
      'Π(x*) = v·a·(v·a/2) − (v·a/2)² = (v·a)²/4.',
      'Break-even: Π(x) = 0 ⇔ x = 0 or √x = v·a ⇔ x = (v·a)² = 4·x*.',
      'With a budget B: Π is increasing on [0, x*], so the best feasible spend is min(B, x*).',
      'Units: v·a·√x = ($/customer)·(customers/√$)·√$ = $; consistent with x in $.',
    ],
    limitations: 'Real response curves can have thresholds (no effect below a minimum spend), saturation ceilings and auction effects; a and v are unknown until estimated from data.',
    references: ['Standard concave response; see e.g. Hanssens, Parsons & Schultz, Market Response Models (2001).'],
    validation: 'illustrative',
    defaults: { a: 1.2, v: 120, B: 3000 },
    params: [
      { key: 'a', label: 'a (customers per √$)', min: 0.1, max: 5, step: 0.1 },
      { key: 'v', label: 'v ($ contribution per customer)', min: 10, max: 1000, step: 10 },
      { key: 'B', label: 'B (budget, $)', min: 0, max: 20000, step: 100 },
    ],
    evaluate(p) {
      const a = num(p, 'a', 1.2)
      const v = num(p, 'v', 120)
      const B = num(p, 'B', 3000)
      const xStar = (v * a / 2) ** 2
      const profit = (x) => v * a * Math.sqrt(Math.max(0, x)) - x
      const xMax = Math.max(4 * xStar * 1.15, B * 1.1, 10)
      const xs = grid(0, xMax, 80)
      return {
        series: [
          { name: 'Π(x) contribution after spend', points: xs.map((x) => [round(x, 2), round(profit(x), 2)]) },
          { name: 'Customers N(x)', points: xs.map((x) => [round(x, 2), round(a * Math.sqrt(x), 3)]), axis: 'right' },
        ],
        markers: [
          { label: 'x* optimum', x: round(xStar, 2) },
          { label: 'budget B', x: B },
          { label: 'break-even', x: round(4 * xStar, 2) },
        ],
        results: { xStar: round(xStar, 2), profitAtOptimum: round(profit(xStar), 2), bestWithinBudget: round(Math.min(B, xStar), 2), profitWithinBudget: round(profit(Math.min(B, xStar)), 2), breakEvenSpend: round(4 * xStar, 2) },
        axes: { x: 'spend x ($)', y: '$' },
      }
    },
    verify(p) {
      const a = num(p, 'a', 1.2)
      const v = num(p, 'v', 120)
      const f = (x) => v * a * Math.sqrt(x) - x
      const xs = (v * a / 2) ** 2
      const xs2 = golden(f, 1e-6, 4 * xs * 1.5 + 1)
      return [
        { check: 'Π′(x*) ≈ 0 (finite difference)', pass: Math.abs(deriv(f, xs)) < 1e-4, value: round(deriv(f, xs), 8), kind: 'numeric' },
        { check: 'Π″(x*) < 0 (concave at the optimum)', pass: deriv2(f, xs) < 0, value: round(deriv2(f, xs), 8), kind: 'numeric' },
        { check: 'Independent search finds the same maximum', pass: Math.abs(xs2 - xs) / Math.max(1, xs) < 1e-3, value: round(xs2, 3), kind: 'numeric' },
        { check: 'Π(x*) = (v·a)²/4', pass: Math.abs(f(xs) - (v * a) ** 2 / 4) < 1e-6 * Math.max(1, f(xs)), value: round(f(xs), 4), kind: 'numeric' },
        { check: 'Π(4x*) = 0 (break-even)', pass: Math.abs(f(4 * xs)) < 1e-6 * Math.max(1, xs), value: round(f(4 * xs), 6), kind: 'numeric' },
        { check: 'Units consistent ($ = $)', pass: true, value: 'v·a·√x and x are both in $', kind: 'derivation' },
      ]
    },
    // Challenge mode: where the derivation stops holding.
    counterexamples() {
      return [
        { case: 'Exponent b ≥ 1 in N = a·x^b (no diminishing returns)', finding: 'Π(x) = v·a·x − x (b = 1) has no interior maximum: profit grows without bound when v·a > 1 and is negative otherwise. The √x result depends entirely on concavity.' },
        { case: 'Threshold response (nothing below a minimum spend m)', finding: 'With N = 0 for x < m, a positive x* can lose money if x* < m; the closed form ignores it.' },
        { case: 'Saturation ceiling (at most K customers)', finding: 'If a·√x* > K, the true optimum is lower: spend beyond (K/a)² buys nothing.' },
      ]
    },
  },
  'GS-ECO-002@1': {
    program: 'GS-ECO-002',
    title: 'Funnel economics: where a percentage point is worth most',
    question: 'Which funnel stage gives the most contribution per point of improvement?',
    objective: 'Contribution after ad spend',
    expression: 'C(S) = S·(q·k·p·s·v / c − 1)',
    variables: [
      { name: 'S', meaning: 'ad spend', unit: '$' },
      { name: 'c', meaning: 'cost per lead', unit: '$/lead' },
      { name: 'q', meaning: 'share of leads that qualify (in area, real need)', unit: 'ratio' },
      { name: 'k', meaning: 'share of qualified leads that book', unit: 'ratio' },
      { name: 'p', meaning: 'share of bookings the provider actually attends', unit: 'ratio' },
      { name: 's', meaning: 'share of attended visits that become a sale', unit: 'ratio' },
      { name: 'v', meaning: 'contribution per sale', unit: '$/sale' },
    ],
    assumptions: ['Leads scale linearly with spend (constant cost per lead; no diminishing returns, unlike GS-ECO-001).', 'Stage rates are independent of each other and of volume (no capacity limit).', 'Contribution per sale is constant.'],
    domain: 'S ≥ 0, c > 0, 0 ≤ q, k, p, s ≤ 1, v ≥ 0',
    derivation: [
      'Leads L = S/c; sales = L·q·k·p·s; gross contribution G = S·q·k·p·s·v/c; C = G − S.',
      'dC/dS = q·k·p·s·v/c − 1: spending more pays only if q·k·p·s·v > c (break-even cost per lead c* = q·k·p·s·v).',
      '∂G/∂q = G/q, and likewise for k, p, s: a +1 point (0.01) rise in a stage adds 0.01·G/rate.',
      'So the stage with the LOWEST rate gives the largest gain per point; a +10% relative rise in any stage adds the same 10% of G.',
      'Units: S·(ratio)·($/sale)/($/lead) = $ when leads and sales are counted per lead; consistent with S in $.',
    ],
    limitations: 'Real stages interact (a stricter qualification lowers q but may raise k and s), capacity caps attended visits, and provider attendance (p) is not recorded separately in GetShowUps today.',
    references: ['Multiplicative conversion funnel; elasticity of a product of factors.'],
    validation: 'illustrative',
    defaults: { S: 2000, c: 40, q: 0.6, k: 0.5, p: 0.9, s: 0.7, v: 300 },
    params: [
      { key: 'S', label: 'S (ad spend, $)', min: 0, max: 20000, step: 100 },
      { key: 'c', label: 'c (cost per lead, $)', min: 1, max: 300, step: 1 },
      { key: 'q', label: 'q (qualified rate)', min: 0, max: 1, step: 0.01 },
      { key: 'k', label: 'k (booking rate)', min: 0, max: 1, step: 0.01 },
      { key: 'p', label: 'p (provider attendance)', min: 0, max: 1, step: 0.01 },
      { key: 's', label: 's (sale rate)', min: 0, max: 1, step: 0.01 },
      { key: 'v', label: 'v (contribution per sale, $)', min: 0, max: 5000, step: 10 },
    ],
    evaluate(p) {
      const P = Object.fromEntries(['S', 'c', 'q', 'k', 'p', 's', 'v'].map((k) => [k, num(p, k, this.defaults[k])]))
      const G = (P.S * P.q * P.k * P.p * P.s * P.v) / P.c
      const stages = ['q', 'k', 'p', 's'].map((k) => ({ stage: k, rate: P[k], valuePerPoint: P[k] > 0 ? round((0.01 * G) / P[k], 2) : null }))
      const best = stages.filter((x) => x.valuePerPoint != null).sort((x, y) => y.valuePerPoint - x.valuePerPoint)[0]
      const xs = grid(0, Math.max(P.S * 2, 100), 60)
      const slope = (P.q * P.k * P.p * P.s * P.v) / P.c - 1
      return {
        series: [{ name: 'C(S) contribution after spend', points: xs.map((S) => [round(S, 2), round(S * slope, 2)]) }],
        markers: [{ label: 'current S', x: P.S }],
        results: { gross: round(G, 2), contribution: round(G - P.S, 2), marginalReturnPerDollar: round(slope, 4), breakEvenCostPerLead: round(P.q * P.k * P.p * P.s * P.v, 2), stages, largestGainPerPoint: best?.stage ?? null },
        axes: { x: 'spend S ($)', y: '$' },
      }
    },
    verify(p) {
      const P = Object.fromEntries(['S', 'c', 'q', 'k', 'p', 's', 'v'].map((k) => [k, num(p, k, this.defaults[k])]))
      const G = (x) => (P.S * x * P.k * P.p * P.s * P.v) / P.c
      const d = deriv(G, P.q, 1e-6)
      return [
        { check: '∂G/∂q = G/q (finite difference)', pass: P.q > 0 && Math.abs(d - G(P.q) / P.q) < 1e-4 * Math.max(1, G(P.q)), value: round(d, 4), kind: 'numeric' },
        (() => {
          const cStar = P.q * P.k * P.p * P.s * P.v
          const C = cStar > 0 ? P.S * ((P.q * P.k * P.p * P.s * P.v) / cStar - 1) : null
          return { check: 'C = 0 when the cost per lead equals c* = q·k·p·s·v', pass: C === null || Math.abs(C) < 1e-9 * Math.max(1, P.S), value: C === null ? 'c* = 0: no cost per lead breaks even' : round(C, 9), kind: 'numeric' }
        })(),
        { check: 'Units consistent', pass: true, value: 'S·ratio·($/sale)/($/lead) = $', kind: 'derivation' },
      ]
    },
    counterexamples() {
      return [
        { case: 'Capacity limit', finding: 'If the provider can attend at most M visits, sales stop growing once L·q·k = M; extra spend is wasted and C falls. This is why demand should not be bought past operational capacity.' },
        { case: 'Interacting stages', finding: 'Tightening qualification can lower q while raising k and s; the "lowest rate first" rule assumes independence.' },
      ]
    },
  },
  'GS-ECO-003@1': {
    program: 'GS-ECO-003',
    title: 'Allocating a budget across campaigns with diminishing returns',
    question: 'How should a fixed budget be split across campaigns?',
    objective: 'Maximize total contribution after spend under a budget',
    expression: 'max Σᵢ (vᵢ·aᵢ·√xᵢ − xᵢ)  s.t.  Σᵢ xᵢ ≤ B, xᵢ ≥ 0',
    variables: [
      { name: 'xᵢ', meaning: 'spend on campaign i', unit: '$' },
      { name: 'aᵢ, vᵢ', meaning: 'response scale and contribution per customer of campaign i (as GS-ECO-001)', unit: 'customers/√$, $/customer' },
      { name: 'B', meaning: 'total budget', unit: '$' },
    ],
    assumptions: ['Each campaign follows GS-ECO-001 independently (no shared audience, no cannibalization).', 'Parameters are known; in practice they are estimates with uncertainty.'],
    domain: 'B ≥ 0, aᵢ, vᵢ > 0',
    derivation: [
      'Unconstrained, each campaign is GS-ECO-001: xᵢ* = (vᵢ·aᵢ/2)².',
      'If Σ xᵢ* ≤ B, the budget does not bind and xᵢ = xᵢ*.',
      'Otherwise (Lagrange, KKT): vᵢ·aᵢ/(2√xᵢ) − 1 = λ for all i with xᵢ > 0, so √xᵢ = vᵢ·aᵢ/(2(1+λ)).',
      'Σ xᵢ = B gives (1+λ)² = Σ (vᵢaᵢ)² / (4B), hence xᵢ = B·(vᵢaᵢ)² / Σⱼ (vⱼaⱼ)².',
      'At the solution every funded campaign has the same marginal return per dollar (λ): no dollar can be moved to gain more.',
      'The objective is a sum of concave functions over a convex set, so this KKT point is the global optimum.',
    ],
    limitations: 'Campaigns often share audiences; parameters must be estimated; small budgets can make some campaigns fall below a minimum effective spend.',
    references: ['Concave resource allocation with a budget constraint (KKT conditions).'],
    validation: 'illustrative',
    defaults: { B: 3000, a1: 1.2, v1: 120, a2: 0.8, v2: 200, a3: 1.5, v3: 60 },
    params: [
      { key: 'B', label: 'B (budget, $)', min: 0, max: 30000, step: 100 },
      { key: 'a1', label: 'a₁', min: 0.1, max: 5, step: 0.1 }, { key: 'v1', label: 'v₁ ($)', min: 10, max: 1000, step: 10 },
      { key: 'a2', label: 'a₂', min: 0.1, max: 5, step: 0.1 }, { key: 'v2', label: 'v₂ ($)', min: 10, max: 1000, step: 10 },
      { key: 'a3', label: 'a₃', min: 0.1, max: 5, step: 0.1 }, { key: 'v3', label: 'v₃ ($)', min: 10, max: 1000, step: 10 },
    ],
    solve(p) {
      const B = num(p, 'B', 3000)
      const c = [1, 2, 3].map((i) => ({ a: num(p, `a${i}`, this.defaults[`a${i}`]), v: num(p, `v${i}`, this.defaults[`v${i}`]) }))
      const free = c.map((x) => (x.v * x.a / 2) ** 2)
      const sumFree = free.reduce((s, x) => s + x, 0)
      const w = c.map((x) => (x.v * x.a) ** 2)
      const sw = w.reduce((s, x) => s + x, 0)
      const alloc = sumFree <= B ? free : w.map((x) => (B * x) / sw)
      return { B, c, alloc, binding: sumFree > B }
    },
    evaluate(p) {
      const { B, c, alloc, binding } = this.solve(p)
      const total = (al) => al.reduce((s, x, i) => s + c[i].v * c[i].a * Math.sqrt(x) - x, 0)
      const even = c.map(() => B / 3)
      const bs = grid(0, Math.max(B * 2, 100), 40)
      return {
        series: [{ name: 'Best total contribution at budget B', points: bs.map((b) => [round(b, 2), round(total(this.solve({ ...p, B: b }).alloc), 2)]) }],
        markers: [{ label: 'budget B', x: B }],
        results: { allocation: alloc.map((x) => round(x, 2)), budgetBinding: binding, totalContribution: round(total(alloc), 2), evenSplitContribution: round(total(even), 2), marginalReturns: alloc.map((x, i) => (x > 0 ? round(c[i].v * c[i].a / (2 * Math.sqrt(x)) - 1, 4) : null)) },
        axes: { x: 'budget B ($)', y: '$' },
      }
    },
    verify(p) {
      const { B, c, alloc, binding } = this.solve(p)
      const mr = alloc.map((x, i) => c[i].v * c[i].a / (2 * Math.sqrt(x)) - 1)
      const total = (al) => al.reduce((s, x, i) => s + c[i].v * c[i].a * Math.sqrt(x) - x, 0)
      const best = total(alloc)
      let beaten = false
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (i !== j) {
        const t = alloc.slice()
        const d = Math.min(t[i], 1)
        t[i] -= d
        t[j] += d
        if (total(t) > best + 1e-6) beaten = true
      }
      return [
        { check: binding ? 'Budget fully used (Σxᵢ = B)' : 'Budget not binding (Σxᵢ* ≤ B)', pass: binding ? Math.abs(alloc.reduce((s, x) => s + x, 0) - B) < 1e-6 * Math.max(1, B) : true, value: round(alloc.reduce((s, x) => s + x, 0), 4), kind: 'numeric' },
        { check: 'Equal marginal return across campaigns (KKT)', pass: Math.max(...mr) - Math.min(...mr) < 1e-6, value: mr.map((x) => round(x, 6)), kind: 'numeric' },
        { check: 'No $1 transfer between campaigns improves the total', pass: !beaten, value: round(best, 4), kind: 'numeric' },
      ]
    },
    counterexamples() {
      return [{ case: 'Shared audience', finding: 'If two campaigns reach the same people, their responses are not additive and the split over-funds the pair.' }, { case: 'Minimum effective spend', finding: 'A campaign with a small share may sit below its threshold; the closed form would fund it uselessly.' }]
    },
  },
  'GS-ECO-007@1': {
    program: 'GS-ECO-007',
    title: 'When to replace a fatiguing ad creative',
    question: 'How often should a creative be replaced when its performance decays?',
    objective: 'Maximize long-run average contribution per day',
    expression: 'r(t) = r₀·e^(−λt) ;  A(T) = (v·r₀·(1 − e^(−λT))/λ − K) / T',
    variables: [
      { name: 'r₀', meaning: 'conversions per day of a fresh creative', unit: 'conversions/day' },
      { name: 'λ', meaning: 'fatigue (decay) rate', unit: '1/day' },
      { name: 'v', meaning: 'contribution per conversion', unit: '$/conversion' },
      { name: 'K', meaning: 'cost of producing and launching a replacement', unit: '$' },
      { name: 'T', meaning: 'replacement interval', unit: 'days' },
    ],
    assumptions: ['Every replacement starts fresh at r₀ with the same decay λ (renewal process).', 'Spend per day is constant and not part of the trade-off.', 'Decay is exponential.'],
    domain: 'r₀, λ, v > 0, K ≥ 0, T > 0',
    derivation: [
      'Contribution in one cycle: ∫₀ᵀ v·r₀·e^(−λt) dt = v·r₀·(1 − e^(−λT))/λ.',
      'Renewal-reward theorem: the long-run average per day is (cycle contribution − K) / T = A(T).',
      'A′(T) = 0 ⇔ v·r₀·e^(−λT)·T = v·r₀·(1 − e^(−λT))/λ − K: at the optimum, the day-T contribution rate equals the average A(T*).',
      'No closed form; T* is found numerically (golden-section search on A).',
      'Rule: replace when today\'s contribution rate has fallen to the long-run average rate.',
    ],
    limitations: 'Fatigue is rarely exactly exponential; replacements are not identical; audience overlap changes λ.',
    references: ['Renewal-reward theorem (e.g. Ross, Stochastic Processes).'],
    validation: 'illustrative',
    defaults: { r0: 5, lambda: 0.05, v: 80, K: 400 },
    params: [
      { key: 'r0', label: 'r₀ (conversions/day)', min: 0.1, max: 50, step: 0.1 },
      { key: 'lambda', label: 'λ (decay per day)', min: 0.001, max: 0.5, step: 0.001 },
      { key: 'v', label: 'v ($ per conversion)', min: 1, max: 1000, step: 1 },
      { key: 'K', label: 'K (replacement cost, $)', min: 0, max: 10000, step: 10 },
    ],
    evaluate(p) {
      const r0 = num(p, 'r0', 5)
      const l = num(p, 'lambda', 0.05)
      const v = num(p, 'v', 80)
      const K = num(p, 'K', 400)
      const A = (T) => (v * r0 * (1 - Math.exp(-l * T)) / l - K) / T
      const Tmax = Math.max(10 / l, 30)
      const T = golden(A, 0.01, Tmax)
      const ts = grid(0.5, Tmax, 80)
      return {
        series: [{ name: 'A(T) average contribution per day', points: ts.map((t) => [round(t, 2), round(A(t), 2)]) }],
        markers: [{ label: 'T* replace every', x: round(T, 2) }],
        results: { replaceEveryDays: round(T, 1), averagePerDay: round(A(T), 2), rateAtReplacement: round(v * r0 * Math.exp(-l * T), 2) },
        axes: { x: 'replacement interval T (days)', y: '$ per day' },
      }
    },
    verify(p) {
      const r0 = num(p, 'r0', 5)
      const l = num(p, 'lambda', 0.05)
      const v = num(p, 'v', 80)
      const K = num(p, 'K', 400)
      const A = (T) => (v * r0 * (1 - Math.exp(-l * T)) / l - K) / T
      const T = golden(A, 0.01, Math.max(10 / l, 30))
      return [
        { check: 'A′(T*) ≈ 0', pass: Math.abs(deriv(A, T)) < 1e-3, value: round(deriv(A, T), 6), kind: 'numeric' },
        { check: 'Rate at T* equals the average A(T*)', pass: Math.abs(v * r0 * Math.exp(-l * T) - A(T)) < 1e-2 * Math.max(1, A(T)), value: [round(v * r0 * Math.exp(-l * T), 4), round(A(T), 4)], kind: 'numeric' },
      ]
    },
    counterexamples() {
      return [{ case: 'K larger than a creative ever earns', finding: 'If v·r₀/λ ≤ K, A(T) < 0 for every T: no replacement schedule pays; the search still returns a T, so read A(T*) before acting.' }]
    },
  },
  'GS-ECO-012@1': {
    program: 'GS-ECO-012',
    title: 'Does GetShowUps pay for itself for a customer?',
    question: 'Under what conditions does the subscription create more value than it costs?',
    objective: 'Net monthly value to the customer',
    expression: 'V = j·m + h·w − P − I/M',
    variables: [
      { name: 'j', meaning: 'INCREMENTAL completed jobs per month caused by GetShowUps', unit: 'jobs/month' },
      { name: 'm', meaning: 'contribution per job (after materials and labor)', unit: '$/job' },
      { name: 'h', meaning: 'admin hours saved per month (verified, not counted again in j)', unit: 'hours/month' },
      { name: 'w', meaning: 'value of an owner hour', unit: '$/hour' },
      { name: 'P', meaning: 'subscription price', unit: '$/month' },
      { name: 'I', meaning: 'one-time implementation and switching cost', unit: '$' },
      { name: 'M', meaning: 'months over which to spread I', unit: 'months' },
    ],
    assumptions: ['j is incremental (jobs that would not have happened anyway), which only an experiment or a credible baseline can measure.', 'Time saved is not also counted as extra jobs (no double counting).', 'Ad spend is outside P and not counted here.'],
    domain: 'all ≥ 0, M > 0',
    derivation: ['Monthly value = incremental contribution + value of time saved − price − amortized one-time cost.', 'Break-even incremental jobs: j* = (P + I/M − h·w)/m (0 if time saved alone covers the cost).', 'Units: (jobs/month)($/job) + (hours/month)($/hour) − $/month − $/month = $/month.'],
    limitations: 'Attribution of jobs to GetShowUps is the hard part; without a baseline, j is unknown and the result is unverified.',
    references: ['Incremental value accounting.'],
    validation: 'illustrative',
    defaults: { j: 3, m: 150, h: 6, w: 40, P: 499, I: 300, M: 12 },
    params: [
      { key: 'j', label: 'j (incremental jobs/month)', min: 0, max: 40, step: 0.5 },
      { key: 'm', label: 'm ($ contribution per job)', min: 0, max: 2000, step: 10 },
      { key: 'h', label: 'h (hours saved/month)', min: 0, max: 80, step: 1 },
      { key: 'w', label: 'w ($ per owner hour)', min: 0, max: 200, step: 5 },
      { key: 'P', label: 'P (price, $/month)', min: 0, max: 2000, step: 1 },
      { key: 'I', label: 'I (one-time cost, $)', min: 0, max: 5000, step: 50 },
      { key: 'M', label: 'M (months)', min: 1, max: 36, step: 1 },
    ],
    evaluate(p) {
      const P = Object.fromEntries(['j', 'm', 'h', 'w', 'P', 'I', 'M'].map((k) => [k, num(p, k, this.defaults[k])]))
      const V = (j) => j * P.m + P.h * P.w - P.P - P.I / P.M
      const jStar = P.m > 0 ? Math.max(0, (P.P + P.I / P.M - P.h * P.w) / P.m) : null
      const js = grid(0, Math.max(P.j * 2, (jStar || 0) * 2, 5), 40)
      return {
        series: [{ name: 'V net value per month', points: js.map((j) => [round(j, 2), round(V(j), 2)]) }],
        markers: [{ label: 'break-even j*', x: jStar == null ? null : round(jStar, 2) }, { label: 'current j', x: P.j }],
        results: { netValuePerMonth: round(V(P.j), 2), breakEvenJobs: jStar == null ? null : round(jStar, 2), roiMultiple: P.P + P.I / P.M > 0 ? round((P.j * P.m + P.h * P.w) / (P.P + P.I / P.M), 2) : null },
        axes: { x: 'incremental jobs per month j', y: '$ per month' },
      }
    },
    verify(p) {
      const P = Object.fromEntries(['j', 'm', 'h', 'w', 'P', 'I', 'M'].map((k) => [k, num(p, k, this.defaults[k])]))
      const jStar = Math.max(0, (P.P + P.I / P.M - P.h * P.w) / P.m)
      const V = (j) => j * P.m + P.h * P.w - P.P - P.I / P.M
      return [{ check: 'V(j*) = 0 when time saved does not already cover the cost', pass: jStar === 0 ? V(0) >= 0 : Math.abs(V(jStar)) < 1e-9 * Math.max(1, P.P), value: round(V(jStar), 6), kind: 'numeric' }]
    },
    counterexamples() {
      return [{ case: 'Double counting', finding: 'If the hours saved were spent doing the extra jobs, counting both h·w and j·m overstates V.' }, { case: 'Non-incremental jobs', finding: 'Jobs booked through GetShowUps that would have come anyway (repeat customers calling directly) are not j.' }]
    },
  },
}
// Public description of a model (no functions).
export const describe = (id) => {
  const m = MODELS[id]
  if (!m) return null
  const fields = ['program', 'title', 'question', 'objective', 'expression', 'variables', 'assumptions', 'domain', 'derivation', 'limitations', 'references', 'validation', 'defaults', 'params']
  return { id, ...Object.fromEntries(fields.map((k) => [k, m[k]])), version: Number(id.split('@')[1]), proof: { derivation: 'analytical, step by step (above)', numeric: 'checked on request', formal: 'not verified (no proof assistant integrated)' } }
}
export const modelList = () => Object.keys(MODELS).map((id) => ({ id, program: MODELS[id].program, title: MODELS[id].title, validation: MODELS[id].validation }))
// Parameters are numbers within each slider's range only: nothing a request sends is ever evaluated as code.
export function cleanParams(id, input) {
  const m = MODELS[id]
  const out = {}
  for (const p of m.params) {
    const v = Number(input?.[p.key])
    out[p.key] = Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : m.defaults[p.key]
  }
  return out
}
