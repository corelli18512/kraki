import { useStore } from '../hooks/useStore';
import type { Store, AppState } from '../types/store';

export function getStore(): Store {
  return useStore.getState();
}

export function setStoreState(partial: Partial<AppState>): void {
  useStore.setState(partial);
}
