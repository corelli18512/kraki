import { agentInfo } from '../../lib/format';

interface AgentAvatarProps {
  agent: string;
  size?: 'sm' | 'md';
}

const sizeClasses = {
  sm: 'h-7 w-7 rounded-md text-sm',
  md: 'h-9 w-9 rounded-lg text-lg',
};

const agentColors: Record<string, string> = {
  copilot: 'bg-kraki-500/15 text-kraki-600 dark:text-kraki-400',
  claude: 'bg-accent-500/15 text-accent-600 dark:text-accent-400',
  codex: 'bg-ocean-500/15 text-ocean-600 dark:text-ocean-400',
};

const fallbackColor = 'bg-surface-tertiary text-text-secondary';

export function AgentAvatar({ agent, size = 'md' }: AgentAvatarProps) {
  const { emoji } = agentInfo(agent);
  const colorClass = agentColors[agent.toLowerCase()] ?? fallbackColor;
  return (
    <div className={`flex shrink-0 items-center justify-center ${colorClass} ${sizeClasses[size]}`}>
      {emoji}
    </div>
  );
}
