const BROKER_PATTERN = /^(\[[0-9a-fA-F:.]+\]|[^\s:[\]]+):(\d{1,5})$/;

export function parseBrokers(input: string): string[] {
  return input
    .split(",")
    .map((b) => b.trim())
    .filter((b) => b.length > 0);
}

export function validateBrokers(input: string): string | undefined {
  const brokers = parseBrokers(input);
  if (brokers.length === 0) {
    return "Enter at least one broker as host:port";
  }
  for (const broker of brokers) {
    const match = BROKER_PATTERN.exec(broker);
    if (!match) {
      return broker.includes(":")
        ? `“${broker}” isn’t a valid host:port address`
        : `“${broker}” is missing a port — use host:port, comma-separated`;
    }
    const port = Number(match[2]);
    if (port < 1 || port > 65535) {
      return `“${broker}” has an invalid port — use 1–65535`;
    }
  }
  if (new Set(brokers).size !== brokers.length) {
    return "The same broker is listed twice";
  }
  return undefined;
}
