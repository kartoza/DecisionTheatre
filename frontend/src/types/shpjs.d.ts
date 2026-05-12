declare module 'shpjs' {
  function shpjs(buffer: ArrayBuffer): Promise<GeoJSON.FeatureCollection>;
  export default shpjs;
}
