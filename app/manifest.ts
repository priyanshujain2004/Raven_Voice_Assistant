import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Raven Voice Agent",
    short_name: "Raven",
    description:
      "Personal Gemini-powered voice assistant for web, mobile, and desktop.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#07111b",
    theme_color: "#10263f",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "48x48",
        type: "image/x-icon",
      },
    ],
  };
}
