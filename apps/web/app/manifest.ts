import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Crossline",
    short_name: "Crossline",
    description: "跨人生主线精力与工作流系统",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f4ef",
    theme_color: "#171722",
    icons: []
  };
}

