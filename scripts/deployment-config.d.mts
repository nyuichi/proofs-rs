export interface DeploymentConfig {
  vars: Record<string, string>;
  send_email?: { name: string; allowed_sender_addresses?: string[] }[];
}
export function configureDeployment(
  config: DeploymentConfig,
  target: string,
  env: Record<string, string | undefined>,
): boolean;
