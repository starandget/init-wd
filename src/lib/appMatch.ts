import type { AppItem } from "@/types";

function norm(s?: string | null): string {
  return (s || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function isAppInList(
  existing: AppItem[],
  candidate: Pick<AppItem, "id" | "name" | "brew_casks" | "brew_formula" | "github_repo">
): boolean {
  const cName = norm(candidate.name);
  const cRepo = norm(candidate.github_repo);
  const cFormula = norm(candidate.brew_formula);
  const cCasks = new Set((candidate.brew_casks || []).map((c) => c.toLowerCase()));

  return existing.some((a) => {
    if (a.id === candidate.id) return true;
    if (cName && norm(a.name) === cName) return true;
    if (cRepo && norm(a.github_repo) === cRepo) return true;
    if (cFormula && norm(a.brew_formula) === cFormula) return true;
    if (cCasks.size > 0 && a.brew_casks.some((c) => cCasks.has(c.toLowerCase()))) {
      return true;
    }
    return false;
  });
}
