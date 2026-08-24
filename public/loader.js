const statusNode = document.querySelector("#status");
const gameNode = document.querySelector("#game");

async function readJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function boot() {
  const channel = await readJson("./channels/demo.json");
  if (!channel.release_manifest) {
    statusNode.textContent = channel.message || "当前频道尚未发布可运行版本。";
    return;
  }

  const manifest = await readJson(channel.release_manifest);
  if (!manifest.entrypoint) throw new Error("发布清单缺少 entrypoint。");

  const frame = document.createElement("iframe");
  frame.src = new URL(manifest.entrypoint, new URL(channel.release_manifest, location.href)).href;
  frame.title = `线路攻防 ${manifest.product_version}`;
  frame.allow = "autoplay; fullscreen; gamepad";
  frame.allowFullscreen = true;

  statusNode.hidden = true;
  gameNode.hidden = false;
  gameNode.replaceChildren(frame);
}

boot().catch((error) => {
  statusNode.textContent = `无法启动 Web Demo：${error.message}`;
  console.error(error);
});
