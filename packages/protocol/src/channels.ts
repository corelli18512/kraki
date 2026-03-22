// ------------------------------------------------------------
// Channel types — DEPRECATED: relay routes by user_id directly
// ------------------------------------------------------------
// Kept for backward compatibility during migration.
// Will be removed in a future version.
// ------------------------------------------------------------
export interface Channel {
  id: string;
  ownerId: string;
  name?: string;
  createdAt: string;
}
