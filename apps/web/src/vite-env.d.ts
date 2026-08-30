/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Basemap tile template. Defaults to public OpenStreetMap tiles, which means
   * the area being viewed is visible to that provider — point this at your own
   * tile server to keep route locations local.
   */
  readonly VITE_MAP_TILES?: string;
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
