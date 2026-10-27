const params = new URLSearchParams(window.location.search);
const playMode = params.get("mode");
const shouldOpenTown = playMode === "roleplay" || playMode === "adventure" || params.get("open") === "dub";

if (shouldOpenTown) {
  document.getElementById("mode-select")?.remove();
  const host = document.getElementById("town");
  if (!host) throw new Error("#town element is missing from index.html");
  host.hidden = false;
  void import("./town/TownGame").then(({ TownGame }) => new TownGame(host));
}
