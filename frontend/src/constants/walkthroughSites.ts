/**
 * Site IDs for the guided demo tours under data/walkthroughs/{id}.json. Each ID
 * must match both the JSON file's own "id" field and the filename, since
 * getSite() and the site list merge in useApi.ts key off this value.
 */

export const AFRICA_SITE_ID = '6dede7c6-8eb3-47a8-a678-16c610b551e6';
export const SHAI_HILLS_SITE_ID = 'd4061726-167d-4074-9f58-4a0de0ed534b';
export const VIPHYA_SITE_ID = '165bcb54-71aa-49de-8e80-bb3142f16eb7';
export const MUNYWANA_SITE_ID = 'fb1066ef-978e-4744-ac62-570a7cb366ed';

export const WALKTHROUGH_SITE_IDS = [
  AFRICA_SITE_ID,
  SHAI_HILLS_SITE_ID,
  VIPHYA_SITE_ID,
  MUNYWANA_SITE_ID,
];
