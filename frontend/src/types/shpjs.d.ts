// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

declare module 'shpjs' {
  function shpjs(buffer: ArrayBuffer): Promise<GeoJSON.FeatureCollection>;
  export default shpjs;
}
