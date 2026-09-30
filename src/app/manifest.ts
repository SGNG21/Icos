import type { MetadataRoute } from "next";

/** Installable ICOS Control Center. Opens straight on the cockpit, standalone. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/cockpit",
    name: "ICOS Control Center",
    short_name: "ICOS",
    description: "Sovereign control plane of ICOS.",
    start_url: "/cockpit",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#04060c",
    theme_color: "#05070d",
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
