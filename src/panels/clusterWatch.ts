import * as vscode from "vscode";
import { ClusterManager } from "../kafka/clusterManager";
import { ClusterConfig, ConnectionStatus } from "../kafka/types";

export interface ClusterWatchHandlers {
  /** The cluster's connection status changed. */
  onStatus(status: ConnectionStatus): void;
  /** The cluster was removed from settings; the panel should close. */
  onRemoved(): void;
  /** The cluster's settings changed (e.g. a rename); `cluster` is the current copy. */
  onChanged(cluster: ClusterConfig): void;
}

/**
 * Keeps a panel in step with its cluster: status changes, removal and edits,
 * including hand edits to settings.json.
 */
export function watchCluster(
  manager: ClusterManager,
  clusterId: string,
  handlers: ClusterWatchHandlers,
): vscode.Disposable {
  let last = JSON.stringify(manager.getCluster(clusterId) ?? null);
  return vscode.Disposable.from(
    manager.onDidChangeStatus((id) => {
      if (id === clusterId) {
        handlers.onStatus(manager.getStatus(id));
      }
    }),
    manager.onDidChangeClusters(() => {
      const cluster = manager.getCluster(clusterId);
      if (!cluster) {
        handlers.onRemoved();
        return;
      }
      const current = JSON.stringify(cluster);
      if (current !== last) {
        last = current;
        handlers.onChanged(cluster);
      }
    }),
  );
}

/** Banner + Connect button shown in a panel whose cluster isn't connected. */
export const disconnectedBannerCss = /* css */ `
  .conn-banner { display: flex; gap: 10px; align-items: center; justify-content: space-between; padding: 8px 20px; font-size: 12px;
    background: var(--vscode-inputValidation-warningBackground); border-bottom: 1px solid var(--vscode-inputValidation-warningBorder); }
  body.offline [data-needs-connection] { opacity: .5; pointer-events: none; }
`;

export function disconnectedBannerHtml(): string {
  return `<div class="conn-banner" id="connBanner" role="alert" hidden>
    <span id="connBannerText">Disconnected.</span>
    <button class="small" id="connBannerBtn">Connect</button>
  </div>`;
}

/** Webview script: shows the banner for any status other than "connected". */
export const disconnectedBannerScript = /* js */ `
    function renderConnection(status, clusterName) {
      const offline = status !== 'connected';
      document.body.classList.toggle('offline', offline);
      $('connBanner').hidden = !offline;
      $('connBannerText').textContent = status === 'connecting' ? 'Connecting to ' + clusterName + '…'
        : status === 'error' ? 'Lost connection to ' + clusterName + '. Data shown may be out of date.'
        : clusterName + ' is disconnected. Data shown may be out of date.';
      $('connBannerBtn').disabled = status === 'connecting';
      $('connBannerBtn').textContent = status === 'error' ? 'Reconnect' : 'Connect';
    }
    $('connBannerBtn').addEventListener('click', () => vscode.postMessage({ command: 'connect' }));
`;
