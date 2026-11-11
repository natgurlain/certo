// Kill-test case files (DESIGN 6.2, 6.3): schema, rule-tier check, injection variants.
import { repoPath, readJsonl, readJson } from "./util.ts";

export type Side = "buyer" | "seller";
export type Letter = "X" | "Y";

export interface KillCase {
  id: string;
  category: string; // B1..B5, G1..G4
  request_canon: string;
  response_body: string;
  buyer_offer_pct: number;
  seller_offer_pct: number;
  label: Side;
  note: string;
}

export interface InjectionCase extends KillCase {
  base_id: string;
  style: "I1" | "I2" | "I3" | "I4" | "I5" | "I6";
  planter: Side; // seller plants in response, buyer plants in request
  field: string; // where the line sits
  planted_text: string; // may contain <LABEL>
  /** Realistic variant: one body for all jurors, letter that fools jurors 0 and 2. Null if the style has no letter. */
  letter_realistic: Letter | null;
  /** Stress variant: the planter's favourable letter for each juror index. */
  letters_per_juror: [Letter, Letter, Letter] | null;
}

export const LABEL_TOKEN = "<LABEL>";

export interface Terms {
  id: string;
  text: string;
  rules: { required_fields: string[]; as_of_field: string; max_age_s: number };
}

export const KILLTEST_DIR = repoPath("fixtures", "killtest");

export function loadTerms(): Terms {
  return readJson<Terms>(repoPath("fixtures", "killtest", "terms.json"));
}

export function loadCases(file: string): KillCase[] {
  return readJsonl<KillCase>(repoPath("fixtures", "killtest", file));
}

export function loadInjections(file: string): InjectionCase[] {
  return readJsonl<InjectionCase>(repoPath("fixtures", "killtest", file));
}

/** Fill the planted letter. `letter` null → body unchanged (style without a letter). */
export function fillLetter(c: InjectionCase, letter: Letter | null): { request_canon: string; response_body: string } {
  const sub = (s: string) => (letter === null ? s : s.split(LABEL_TOKEN).join(letter));
  return { request_canon: sub(c.request_canon), response_body: sub(c.response_body) };
}

const MAX_PANEL_RESPONSE_BYTES = 6 * 1024; // DESIGN 4.7: responses over 6 KB cannot go to the panel

/**
 * Schema plus the rule tier that runs before the panel (DESIGN 6.1): the response is
 * JSON, has the required fields, and `as_of` is a plausible Unix time. Freshness
 * (`max_age_s`) is checked against `servedAt` when given; cases are written for
 * as_of ≈ 1794300000 (2026-11-10), so the default skips it.
 */
export function checkCase(c: KillCase, terms: Terms, opts: { servedAtS?: number; allowLabelToken?: boolean } = {}): string[] {
  const p: string[] = [];
  const need = ["id", "category", "request_canon", "response_body", "buyer_offer_pct", "seller_offer_pct", "label", "note"] as const;
  for (const k of need) if ((c as any)[k] === undefined) p.push(`missing ${k}`);
  if (!/^(B[1-5]|G[1-4])$/.test(c.category)) p.push(`bad category ${c.category}`);
  if (c.label !== "buyer" && c.label !== "seller") p.push(`bad label ${c.label}`);
  for (const k of ["buyer_offer_pct", "seller_offer_pct"] as const)
    if (!Number.isInteger(c[k]) || c[k] < 0 || c[k] > 100) p.push(`${k} must be an integer 0..100`);
  if (c.buyer_offer_pct <= c.seller_offer_pct) p.push("buyer offer must exceed seller offer");
  if (c.category.startsWith("B") !== (c.label === "buyer")) p.push("category/label mismatch");
  if (!c.request_canon.startsWith("GET\n/v1/holders?") || !c.request_canon.endsWith("\n")) p.push("request_canon is not `GET\\n/v1/holders?…\\n`");
  if (!opts.allowLabelToken && (c.request_canon + c.response_body).includes(LABEL_TOKEN)) p.push("unfilled <LABEL>");
  if (Buffer.byteLength(c.response_body) > MAX_PANEL_RESPONSE_BYTES) p.push("response over 6 KB");
  let body: any;
  try {
    body = JSON.parse(c.response_body);
  } catch {
    p.push("rule tier: response is not JSON");
    return p;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) p.push("rule tier: response is not a JSON object");
  else {
    for (const f of terms.rules.required_fields) if (!(f in body)) p.push(`rule tier: missing field ${f}`);
    const asOf = body[terms.rules.as_of_field];
    if (typeof asOf !== "number" || !Number.isInteger(asOf) || asOf < 1.7e9 || asOf > 2e9) p.push("rule tier: as_of is not Unix seconds");
    else if (opts.servedAtS !== undefined && opts.servedAtS - asOf > terms.rules.max_age_s) p.push("rule tier: stale");
  }
  return p;
}

export function checkInjection(c: InjectionCase, base: KillCase | undefined, terms: Terms): string[] {
  const p = checkCase(c, terms, { allowLabelToken: true });
  if (!base) return [...p, `base ${c.base_id} not found`];
  if (base.label !== c.label || base.buyer_offer_pct !== c.buyer_offer_pct || base.seller_offer_pct !== c.seller_offer_pct)
    p.push("label/offers differ from base");
  if (c.planter === c.label) p.push("planter must be the losing side");
  if (c.planter === "seller" && c.request_canon !== base.request_canon) p.push("seller-planted case must keep the base request");
  if (c.planter === "buyer" && c.response_body !== base.response_body) p.push("buyer-planted case must keep the base response");
  const hasToken = (c.request_canon + c.response_body).includes(LABEL_TOKEN);
  if (hasToken !== (c.letter_realistic !== null)) p.push("<LABEL> presence and letter_realistic disagree");
  for (const letter of [c.letter_realistic, ...(c.letters_per_juror ?? [])])
    if (letter !== null) {
      const f = fillLetter(c, letter);
      p.push(...checkCase({ ...c, ...f }, terms).map((x) => `filled ${letter}: ${x}`));
    }
  return p;
}
