import {
  LayoutDashboard, Users, Bell, MessageSquare, Receipt,
  Cpu, Truck, Building2, UserCog, Sparkles, Settings, GitBranch, Timer,
} from 'lucide-react-native';
import type { Role } from '@/contexts/role-context';
import type { LucideIcon } from 'lucide-react-native';

export type NavItem = {
  label: string;
  route: string;
  icon: LucideIcon;
  roles?: Role[];
  parent?: string;
};

export const navItems: NavItem[] = [
  { label: 'Command Center',       route: '/',                        icon: LayoutDashboard },
  { label: 'Patient Registry',     route: '/patients',                icon: Users },
  { label: 'Alerts & Triage',      route: '/alerts',                  icon: Bell },
  { label: 'Communications',       route: '/communications',          icon: MessageSquare },
  { label: 'Billing & Compliance', route: '/billing',                 icon: Receipt,   roles: ['super_admin'] },
  { label: 'Devices',              route: '/devices',                 icon: Cpu,       roles: ['super_admin'] },
  { label: 'Device Orders',        route: '/devices/orders',          icon: Truck,     roles: ['super_admin'] },
  { label: 'Clinics',              route: '/clinics',                 icon: Building2, roles: ['super_admin'] },
  { label: 'Time Reviews',         route: '/clinics/time-reviews',    icon: Timer,     roles: ['super_admin', 'clinic_admin'], parent: '/clinics' },
  { label: 'Staff',                route: '/staff',                   icon: UserCog,   roles: ['super_admin', 'clinic_admin'] },
  { label: 'Workflows',            route: '/workflows',               icon: GitBranch, roles: ['super_admin', 'clinic_admin'] },
  { label: 'AI Assistant',         route: '/ai',                      icon: Sparkles },
  { label: 'Settings',             route: '/settings',                icon: Settings,  roles: ['super_admin', 'clinic_admin'] },
];
