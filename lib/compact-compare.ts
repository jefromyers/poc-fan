import type { ReadUrlGraph } from "@/lib/url-graph";

export type CompactRole = {
  role: string;
  run_id: string;
  query: string;
  model?: string;
  status?: string;
  counts?: Record<string, unknown>;
};

type Unit = "page" | "folder" | "domain";

type UnitGroup = {
  key: string;
  roles: Set<string>;
  citedRoles: Set<string>;
  urls: Set<string>;
  domain?: string;
  folder?: string;
};

function matrix(roles: string[], groups: UnitGroup[]) {
  const out: Record<string, Record<string, number>> = {};
  for (const a of roles) {
    out[a] = {};
    for (const b of roles) out[a][b] = 0;
  }
  for (const group of groups) {
    for (const a of roles) {
      if (!group.roles.has(a)) continue;
      for (const b of roles) {
        if (a !== b && group.roles.has(b)) out[a][b] += 1;
      }
    }
  }
  return out;
}

function addGroup(map: Map<string, UnitGroup>, key: string, role: string, url: string, cited: boolean) {
  let group = map.get(key);
  if (!group) {
    group = { key, roles: new Set(), citedRoles: new Set(), urls: new Set() };
    map.set(key, group);
  }
  group.roles.add(role);
  group.urls.add(url);
  if (cited) group.citedRoles.add(role);
  return group;
}

function sortedCommons(groups: UnitGroup[], unit: Unit, topN: number) {
  return groups
    .filter((group) => group.roles.size >= 2)
    .sort(
      (a, b) =>
        b.roles.size - a.roles.size ||
        b.urls.size - a.urls.size ||
        a.key.localeCompare(b.key),
    )
    .slice(0, topN)
    .map((group) => ({
      unit,
      key: group.key,
      domain: group.domain,
      folder: group.folder,
      role_count: group.roles.size,
      roles: [...group.roles].sort(),
      cited_roles: [...group.citedRoles].sort(),
      url_count: group.urls.size,
      sample_urls: [...group.urls].sort().slice(0, 5),
    }));
}

export function buildCompactCompare(
  graph: ReadUrlGraph,
  roles: CompactRole[],
  opts: { topN?: number } = {},
) {
  const topN = Math.min(100, Math.max(1, Math.floor(opts.topN ?? 25)));
  const roleNames = roles.map((role) => role.role);
  const pageGroups = new Map<string, UnitGroup>();
  const folderGroups = new Map<string, UnitGroup>();
  const domainGroups = new Map<string, UnitGroup>();
  const counts = new Map<
    string,
    {
      pages: Set<string>;
      folders: Set<string>;
      domains: Set<string>;
      cited_pages: Set<string>;
    }
  >();

  for (const role of roleNames) {
    counts.set(role, {
      pages: new Set(),
      folders: new Set(),
      domains: new Set(),
      cited_pages: new Set(),
    });
  }

  for (const row of graph.rows) {
    for (const perRole of row.per_role) {
      const roleCounts = counts.get(perRole.role);
      roleCounts?.pages.add(row.url);
      roleCounts?.folders.add(row.folder);
      roleCounts?.domains.add(row.registrable_domain);
      if (perRole.cited) roleCounts?.cited_pages.add(row.url);

      const page = addGroup(pageGroups, row.url, perRole.role, row.url, perRole.cited);
      page.domain = row.registrable_domain;
      page.folder = row.folder;
      const folder = addGroup(folderGroups, row.folder, perRole.role, row.url, perRole.cited);
      folder.domain = row.registrable_domain;
      folder.folder = row.folder;
      const domain = addGroup(domainGroups, row.registrable_domain, perRole.role, row.url, perRole.cited);
      domain.domain = row.registrable_domain;
    }
  }

  const fanoutByRole = new Map(graph.queryFanout.map((entry) => [entry.role, entry]));
  return {
    role_count: roleNames.length,
    read_url_count: graph.rowCount,
    profileVersion: graph.profileVersion,
    generatedAt: graph.generatedAt,
    roles: roles.map((role) => {
      const roleCounts = counts.get(role.role);
      const fanout = fanoutByRole.get(role.role);
      return {
        role: role.role,
        run_id: role.run_id,
        query: role.query,
        model: role.model,
        status: role.status,
        counts: {
          pages: roleCounts?.pages.size ?? 0,
          folders: roleCounts?.folders.size ?? 0,
          domains: roleCounts?.domains.size ?? 0,
          cited_pages: roleCounts?.cited_pages.size ?? 0,
          search_actions: fanout?.actions.filter((action) => action.type === "search").length ?? 0,
          search_queries: fanout?.search_queries.length ?? 0,
          ...(role.counts ?? {}),
        },
      };
    }),
    matrices: {
      pages: matrix(roleNames, [...pageGroups.values()]),
      folders: matrix(roleNames, [...folderGroups.values()]),
      domains: matrix(roleNames, [...domainGroups.values()]),
    },
    top_common: {
      pages: sortedCommons([...pageGroups.values()], "page", topN),
      folders: sortedCommons([...folderGroups.values()], "folder", topN),
      domains: sortedCommons([...domainGroups.values()], "domain", topN),
    },
  };
}
