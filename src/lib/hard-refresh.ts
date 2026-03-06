"use client";

async function clearServiceWorkers() {
  if (!("serviceWorker" in navigator)) {
    return;
  }
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(
    registrations.map(async (registration) => {
      try {
        await registration.update();
        await registration.unregister();
      } catch {
        // ignore and continue
      }
    }),
  );
}

async function clearCaches() {
  if (!("caches" in window)) {
    return;
  }
  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}

export async function runHardRefresh() {
  try {
    await Promise.all([clearServiceWorkers(), clearCaches()]);
    const url = new URL(window.location.href);
    url.searchParams.set("__hard_reload", String(Date.now()));
    window.location.replace(url.toString());
    return;
  } catch {
    // ignore and fallback to normal reload
  }
  window.location.reload();
}
