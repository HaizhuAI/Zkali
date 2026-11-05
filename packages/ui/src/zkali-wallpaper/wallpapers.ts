// 内置壁纸目录：由 scripts/generate-wallpapers.mjs 程序化生成的原创 SVG。
// ?url 导入交给 vite 打包为资源 URL，桌面与 Web 同一条路径。

import neonHorizonUrl from "@/assets/wallpapers/neon-horizon.svg?url";
import signalRainUrl from "@/assets/wallpapers/signal-rain.svg?url";
import circuitBoardUrl from "@/assets/wallpapers/circuit-board.svg?url";
import topoRidgeUrl from "@/assets/wallpapers/topo-ridge.svg?url";
import hexMeshUrl from "@/assets/wallpapers/hex-mesh.svg?url";
import zkaliTerminalUrl from "@/assets/wallpapers/zkali-terminal.svg?url";

export interface ZkaliWallpaper {
  id: string;
  url: string;
  /** 画廊缩略底色，加载完成前先铺纯色避免闪白。 */
  baseColor: string;
}

export const ZKALI_WALLPAPERS: readonly ZkaliWallpaper[] = [
  { id: "hex-mesh", url: hexMeshUrl, baseColor: "#08131d" },
  { id: "zkali-terminal", url: zkaliTerminalUrl, baseColor: "#04090e" },
  { id: "signal-rain", url: signalRainUrl, baseColor: "#020806" },
  { id: "circuit-board", url: circuitBoardUrl, baseColor: "#070c16" },
  { id: "topo-ridge", url: topoRidgeUrl, baseColor: "#050b12" },
  { id: "neon-horizon", url: neonHorizonUrl, baseColor: "#09041c" },
];

export function findWallpaper(id: string): ZkaliWallpaper | undefined {
  return ZKALI_WALLPAPERS.find((wallpaper) => wallpaper.id === id);
}
