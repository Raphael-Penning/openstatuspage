/** History importers per monitoring source type. CSV works for every configurable type. */
import type { MonitorSourceType } from '@openstatuspage/shared';
import { icingaDbImporter } from './icingadb.js';
import { openItCockpitImporter } from './openitcockpit.js';
import type { HistoryImporter } from './types.js';
import { uptimeKumaImporter } from './uptimekuma.js';

export type ImporterRegistry = Partial<Record<MonitorSourceType, HistoryImporter<any>>>;

export const defaultImporters: ImporterRegistry = {
  icinga2: icingaDbImporter,
  uptimekuma: uptimeKumaImporter,
  openitcockpit: openItCockpitImporter,
};
