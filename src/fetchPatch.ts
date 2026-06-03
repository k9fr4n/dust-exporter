// Workaround temporaire pour le bug serveur de redirect SSE (dust-tt#26472).
// `redirectToSse` (front-api) renvoie un 307 vers /api/sse/api/v1/... (double /api),
// qui 404. Le SDK suit le redirect automatiquement et n'a aucun moyen de le corriger.
// On intercepte donc le redirect manuellement et on réécrit le Location.
// -> No-op une fois le fix serveur déployé (le replace ne s'applique plus).

const originalFetch = globalThis.fetch;

// On ne cible QUE les endpoints de flux d'événements SSE, pour ne rien casser d'autre.
const SSE_EVENTS_RE =
  /\/api\/v1\/w\/[^/]+\/assistant\/conversations\/[^/]+\/(events|messages\/[^/]+\/events)/;

globalThis.fetch = (async (input: any, init: any = {}) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : (input?.url ?? "");

  if (!SSE_EVENTS_RE.test(url)) {
    return originalFetch(input, init);
  }

  // On prend la main sur le suivi des redirects.
  let res = await originalFetch(input, { ...init, redirect: "manual" });

  let hops = 0;
  while ([301, 302, 307, 308].includes(res.status) && hops < 5) {
    hops++;
    const location = res.headers.get("location");
    if (!location) {
      break;
    }

    // Le fix : on retire le double préfixe /api/sse/api/ -> /api/sse/
    const fixed = location.replace("/api/sse/api/", "/api/sse/");
    const nextUrl = new URL(fixed, url).toString();

    res = await originalFetch(nextUrl, { ...init, redirect: "manual" });
  }

  return res;
}) as typeof fetch;
