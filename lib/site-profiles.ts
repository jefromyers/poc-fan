// Site-type / weight / folder-depth profile table — the rules that classify a
// read URL's domain and decide how finely to fold its folder path and how much
// to weight it. Garrett (Citation Labs) owns the CONTENT here; edit this file to
// tune. Seeded from his dev-request table (2026-06-02).
//
// CRITICAL: `weight` is a STORED OUTPUT COLUMN, never a filter. The graph emits
// raw counts at every resolution AND the weight; downstream analysis decides
// what to apply. Nothing here pre-collapses or drops anything.
//
// Server-only (imported by lib/url-graph.ts → a Node API route). Do not import
// from client code.

export const PROFILE_VERSION = "2026-06-03"; // bump when rules change; stamped into output

export type SiteProfile = {
  site_type: string;
  weight: number;
  folder_depth: number; // # leading path segments that define a "folder"
  page_level: boolean; // true → each URL is its own folder unit (folder == url)
  high_volume: boolean; // scraper/aggregator; surfaced as high_volume_flag
};

// Profiles for whole site classes. Reused by the maps below.
const REGULATOR: SiteProfile = { site_type: "regulator", weight: 1.0, folder_depth: 2, page_level: false, high_volume: false };
const VENDOR: SiteProfile = { site_type: "vendor", weight: 1.0, folder_depth: 1, page_level: false, high_volume: false };
const FLAT_DOC: SiteProfile = { site_type: "flat-doc-store", weight: 1.0, folder_depth: 1, page_level: true, high_volume: false };
const SCRAPER: SiteProfile = { site_type: "hub/scraper", weight: 0.2, folder_depth: 1, page_level: true, high_volume: true };
const EDU: SiteProfile = { site_type: "edu", weight: 1.0, folder_depth: 1, page_level: false, high_volume: false };

export const DEFAULT_PROFILE: SiteProfile = {
  site_type: "default",
  weight: 1.0,
  folder_depth: 1,
  page_level: false,
  high_volume: false,
};

// Most specific first: exact HOST overrides (e.g. distinguish ema.europa.eu the
// regulator from an arbitrary *.europa.eu host).
export const HOST_PROFILES: Record<string, SiteProfile> = {
  "ema.europa.eu": REGULATOR,
  "eur-lex.europa.eu": REGULATOR,
  "standards.iteh.ai": SCRAPER,
};

// Registrable-domain (eTLD+1) profiles — apply to the domain and all its hosts.
export const DOMAIN_PROFILES: Record<string, SiteProfile> = {
  // regulators / authorities
  "fda.gov": REGULATOR,
  "nist.gov": REGULATOR,
  "iec.ch": REGULATOR,
  "europa.eu": REGULATOR,
  // vendors
  "onlogic.com": VENDOR,
  "advantech.com": VENDOR,
  "siemens.com": VENDOR,
  "nvidia.com": VENDOR,
  // hubs / aggregators / scrapers (high-volume → down-weighted + flagged)
  "reddit.com": SCRAPER,
  "wikipedia.org": SCRAPER,
  "arxiv.org": SCRAPER,
  "studylib.net": SCRAPER,
  "manualzz.com": SCRAPER,
  "paperzz.com": SCRAPER,
};

// Coarse suffix fallbacks (lowest precedence before DEFAULT). Conservative —
// classification + folder depth only, no down-weighting.
export const SUFFIX_PROFILES: { suffix: string; profile: SiteProfile }[] = [
  { suffix: ".gov", profile: REGULATOR },
  { suffix: ".edu", profile: EDU },
];

// Auto-flag thresholds for scrapers we haven't profiled: a registrable domain
// with many distinct URLs but ~no repeat across the corpus. Tunable; see
// url-graph.ts for how they're applied (only when no explicit profile matched).
export const AUTO_FLAG = { minDistinctUrls: 15, maxMeanReadsPerUrl: 1.2 };

// Resolve the profile for a host + its registrable domain. Precedence:
// exact host → registrable domain → suffix → DEFAULT. (Auto-flag for unprofiled
// high-volume domains is applied by the graph builder, which has corpus stats.)
export function resolveProfile(host: string, registrable: string): SiteProfile {
  if (HOST_PROFILES[host]) return HOST_PROFILES[host];
  if (DOMAIN_PROFILES[registrable]) return DOMAIN_PROFILES[registrable];
  for (const { suffix, profile } of SUFFIX_PROFILES) {
    if (registrable.endsWith(suffix) || host.endsWith(suffix)) return profile;
  }
  return DEFAULT_PROFILE;
}
