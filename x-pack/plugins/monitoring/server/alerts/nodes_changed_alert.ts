/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */
import { IUiSettingsClient } from 'kibana/server';
import { i18n } from '@kbn/i18n';
import { BaseAlert } from './base_alert';
import {
  AlertData,
  AlertCluster,
  AlertState,
  AlertMessage,
  AlertInstanceState,
  LegacyAlert,
  LegacyAlertNodesChangedList,
  CommonAlertParams,
} from '../../common/types/alerts';
import { AlertInstance } from '../../../alerts/server';
import { INDEX_ALERTS, ALERT_NODES_CHANGED, LEGACY_ALERT_DETAILS } from '../../common/constants';
import { getCcsIndexPattern } from '../lib/alerts/get_ccs_index_pattern';
import { fetchLegacyAlerts } from '../lib/alerts/fetch_legacy_alerts';
import { mapLegacySeverity } from '../lib/alerts/map_legacy_severity';
import { AlertingDefaults } from './alert_helpers';

const WATCH_NAME = 'elasticsearch_nodes';

export class NodesChangedAlert extends BaseAlert {
  public type = ALERT_NODES_CHANGED;
  public label = LEGACY_ALERT_DETAILS[ALERT_NODES_CHANGED].label;
  public isLegacy = true;

  protected actionVariables = [
    {
      name: 'added',
      description: i18n.translate('xpack.monitoring.alerts.nodesChanged.actionVariables.added', {
        defaultMessage: 'The list of nodes added to the cluster.',
      }),
    },
    {
      name: 'removed',
      description: i18n.translate('xpack.monitoring.alerts.nodesChanged.actionVariables.removed', {
        defaultMessage: 'The list of nodes removed from the cluster.',
      }),
    },
    {
      name: 'restarted',
      description: i18n.translate(
        'xpack.monitoring.alerts.nodesChanged.actionVariables.restarted',
        {
          defaultMessage: 'The list of nodes restarted in the cluster.',
        }
      ),
    },
    ...Object.values(AlertingDefaults.ALERT_TYPE.context),
  ];

  private getNodeStates(legacyAlert: LegacyAlert): LegacyAlertNodesChangedList | undefined {
    return legacyAlert.nodes;
  }

  protected async fetchData(
    params: CommonAlertParams,
    callCluster: any,
    clusters: AlertCluster[],
    uiSettings: IUiSettingsClient,
    availableCcs: string[]
  ): Promise<AlertData[]> {
    let alertIndexPattern = INDEX_ALERTS;
    if (availableCcs) {
      alertIndexPattern = getCcsIndexPattern(alertIndexPattern, availableCcs);
    }
    const legacyAlerts = await fetchLegacyAlerts(
      callCluster,
      clusters,
      alertIndexPattern,
      WATCH_NAME,
      this.config.ui.max_bucket_size
    );
    return legacyAlerts.reduce((accum: AlertData[], legacyAlert) => {
      accum.push({
        instanceKey: `${legacyAlert.metadata.cluster_uuid}`,
        clusterUuid: legacyAlert.metadata.cluster_uuid,
        shouldFire: true, // This alert always has a resolved timestamp
        severity: mapLegacySeverity(legacyAlert.metadata.severity),
        meta: legacyAlert,
      });
      return accum;
    }, []);
  }

  protected getUiMessage(alertState: AlertState, item: AlertData): AlertMessage {
    const legacyAlert = item.meta as LegacyAlert;
    const states = this.getNodeStates(legacyAlert) || { added: {}, removed: {}, restarted: {} };
    if (!alertState.ui.isFiring) {
      return {
        text: i18n.translate('xpack.monitoring.alerts.nodesChanged.ui.resolvedMessage', {
          defaultMessage: `No changes in Elasticsearch nodes for this cluster.`,
        }),
      };
    }

    if (
      Object.values(states.added).length === 0 &&
      Object.values(states.removed).length === 0 &&
      Object.values(states.restarted).length === 0
    ) {
      return {
        text: i18n.translate(
          'xpack.monitoring.alerts.nodesChanged.ui.nothingDetectedFiringMessage',
          {
            defaultMessage: `Elasticsearch nodes have changed`,
          }
        ),
      };
    }

    const addedText =
      Object.values(states.added).length > 0
        ? i18n.translate('xpack.monitoring.alerts.nodesChanged.ui.addedFiringMessage', {
            defaultMessage: `Elasticsearch nodes '{added}' added to this cluster.`,
            values: {
              added: Object.values(states.added).join(','),
            },
          })
        : null;
    const removedText =
      Object.values(states.removed).length > 0
        ? i18n.translate('xpack.monitoring.alerts.nodesChanged.ui.removedFiringMessage', {
            defaultMessage: `Elasticsearch nodes '{removed}' removed from this cluster.`,
            values: {
              removed: Object.values(states.removed).join(','),
            },
          })
        : null;
    const restartedText =
      Object.values(states.restarted).length > 0
        ? i18n.translate('xpack.monitoring.alerts.nodesChanged.ui.restartedFiringMessage', {
            defaultMessage: `Elasticsearch nodes '{restarted}' restarted in this cluster.`,
            values: {
              restarted: Object.values(states.restarted).join(','),
            },
          })
        : null;

    return {
      text: [addedText, removedText, restartedText].filter(Boolean).join(' '),
    };
  }

  protected async executeActions(
    instance: AlertInstance,
    instanceState: AlertInstanceState,
    item: AlertData,
    cluster: AlertCluster
  ) {
    if (instanceState.alertStates.length === 0) {
      return;
    }
    const alertState = instanceState.alertStates[0];
    const legacyAlert = item.meta as LegacyAlert;
    if (!alertState.ui.isFiring) {
      instance.scheduleActions('default', {
        internalShortMessage: i18n.translate(
          'xpack.monitoring.alerts.nodesChanged.resolved.internalShortMessage',
          {
            defaultMessage: `Elasticsearch nodes changed alert is resolved for {clusterName}.`,
            values: {
              clusterName: cluster.clusterName,
            },
          }
        ),
        internalFullMessage: i18n.translate(
          'xpack.monitoring.alerts.nodesChanged.resolved.internalFullMessage',
          {
            defaultMessage: `Elasticsearch nodes changed alert is resolved for {clusterName}.`,
            values: {
              clusterName: cluster.clusterName,
            },
          }
        ),
        state: AlertingDefaults.ALERT_STATE.resolved,
        clusterName: cluster.clusterName,
      });
    } else {
      const shortActionText = i18n.translate('xpack.monitoring.alerts.nodesChanged.shortAction', {
        defaultMessage: 'Verify that you added, removed, or restarted nodes.',
      });
      const fullActionText = i18n.translate('xpack.monitoring.alerts.nodesChanged.fullAction', {
        defaultMessage: 'View nodes',
      });
      const action = `[${fullActionText}](elasticsearch/nodes)`;
      const states = this.getNodeStates(legacyAlert) || { added: {}, removed: {}, restarted: {} };
      const added = Object.values(states.added).join(',');
      const removed = Object.values(states.removed).join(',');
      const restarted = Object.values(states.restarted).join(',');
      instance.scheduleActions('default', {
        internalShortMessage: i18n.translate(
          'xpack.monitoring.alerts.nodesChanged.firing.internalShortMessage',
          {
            defaultMessage: `Nodes changed alert is firing for {clusterName}. {shortActionText}`,
            values: {
              clusterName: cluster.clusterName,
              shortActionText,
            },
          }
        ),
        internalFullMessage: i18n.translate(
          'xpack.monitoring.alerts.nodesChanged.firing.internalFullMessage',
          {
            defaultMessage: `Nodes changed alert is firing for {clusterName}. The following Elasticsearch nodes have been added:{added} removed:{removed} restarted:{restarted}. {action}`,
            values: {
              clusterName: cluster.clusterName,
              added,
              removed,
              restarted,
              action,
            },
          }
        ),
        state: AlertingDefaults.ALERT_STATE.firing,
        clusterName: cluster.clusterName,
        added,
        removed,
        restarted,
        action,
        actionPlain: shortActionText,
      });
    }
  }
}
