import { stringToHue } from '../../lib/color';
import { ShieldQuestion, MessageCircleQuestion } from 'lucide-react';

interface AgentAvatarProps {
  agent: string;
  sessionId?: string;
  size?: 'sm' | 'md';
  status?: 'active' | 'idle';
  badge?: 'question' | 'permission';
  pinned?: boolean;
}

const sizeMap = {
  sm: { container: 'h-7 w-7 rounded-md', icon: 'h-4 w-4' },
  md: { container: 'h-9 w-9 rounded-lg', icon: 'h-5 w-5' },
};

function CopilotIcon({ className }: { className?: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M23.922 16.992c-.861 1.495-5.859 5.023-11.922 5.023-6.063 0-11.061-3.528-11.922-5.023A.641.641 0 0 1 0 16.736v-2.869a.841.841 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.195 10.195 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952 1.399-1.136 3.392-2.093 6.122-2.093 2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.832.832 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256ZM12.172 11h-.344a4.323 4.323 0 0 1-.355.508C10.703 12.455 9.555 13 7.965 13c-1.725 0-2.989-.359-3.782-1.259a2.005 2.005 0 0 1-.085-.104L4 11.741v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.323 4.323 0 0 1-.355-.508h-.016.016Zm.641-2.935c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" />
      <path d="M14.5 14.25a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Zm-5 0a1 1 0 0 1 1 1v2a1 1 0 0 1-2 0v-2a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

function ClaudeIcon({ className }: { className?: string }) {
  // Claude Code pixel art icon, moderately stretched to look balanced in a square avatar
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 1.5 26 20.5" preserveAspectRatio="none" fill="currentColor" className={className}>
      <path d="M21 10.5h3v3h-3v3h-1.5v3H18v-3h-1.5v3H15v-3H9v3H7.5v-3H6v3H4.5v-3H3v-3H0v-3h3v-6h18Zm-15 0h1.5v-3H6Zm10.5 0H18v-3h-1.5z"/>
    </svg>
  );
}

function PiIcon({ className }: { className?: string }) {
  // Official pi mark (pi.dev): geometric "P" with a square hole + an "i" dot.
  // viewBox is padded around the content bounds (165.29–634.72) so the mark
  // renders at ~84% of the icon box, matching Claude/Copilot's visual weight.
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="120.29 120.29 559.43 559.43" fill="currentColor" className={className}>
      <path fillRule="evenodd" d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"/>
      <path d="M517.36 400H634.72V634.72H517.36Z"/>
    </svg>
  );
}

function AgentIcon({ agent, className }: { agent: string; className?: string }) {
  switch (agent) {
    case 'claude': return <ClaudeIcon className={className} />;
    case 'pi': return <PiIcon className={className} />;
    case 'copilot':
    default: return <CopilotIcon className={className} />;
  }
}

export function AgentAvatar({ agent, sessionId, size = 'md', status, badge, pinned }: AgentAvatarProps) {
  const s = sizeMap[size];
  const hue = stringToHue(sessionId ?? agent);

  const BadgeIcon = badge === 'permission' ? ShieldQuestion
    : badge === 'question' ? MessageCircleQuestion
    : null;

  const badgeIconSize = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  const pinSize = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={`flex items-center justify-center ${s.container}`}
        style={{ backgroundColor: `hsl(${hue}, 50%, 90%)`, color: `hsl(${hue}, 60%, 40%)` }}
      >
        <AgentIcon agent={agent} className={s.icon} />
      </div>
      {BadgeIcon && (
        <span className="absolute -bottom-1 -right-1.5 rounded-full bg-surface-primary p-[1px] text-kraki-500">
          <BadgeIcon className={badgeIconSize} />
        </span>
      )}
      {pinned && (
        <span
          className="absolute -top-1 -left-1 z-10 -rotate-45"
          style={{ color: `hsl(${hue}, 60%, 40%)` }}
        >
          <svg className={pinSize} viewBox="0 0 24 24" fill="currentColor"><path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" /></svg>
        </span>
      )}
    </div>
  );
}
