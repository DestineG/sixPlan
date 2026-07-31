import { create } from 'zustand';
import type { UserDto } from '@sixplan/shared';

interface AuthState {
  user: UserDto | null;
  ready: boolean;
  setUser: (user: UserDto | null) => void;
  setReady: (ready: boolean) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  ready: false,
  setUser: (user) => set({ user }),
  setReady: (ready) => set({ ready })
}));
