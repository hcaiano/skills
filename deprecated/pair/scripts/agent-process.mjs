import { basename } from "node:path";

export const agentExecutableBasenames = Object.freeze({
  cursor: Object.freeze(["cursor", "cursor-agent"]),
});

export const acceptedAgentBasenames = (agent) =>
  agentExecutableBasenames[agent] ?? [agent];

export const matchingForegroundProcess = (info, agent, repoRoot) => {
  const accepted = acceptedAgentBasenames(agent);
  return info.foreground_processes.find((entry) => {
    const executables = [entry.name, entry.argv0, entry.argv?.[0]]
      .filter((value) => typeof value === "string")
      .map((value) => basename(value).toLowerCase());
    return executables.some((executable) => accepted.includes(executable))
      && entry.cwd === repoRoot;
  });
};
