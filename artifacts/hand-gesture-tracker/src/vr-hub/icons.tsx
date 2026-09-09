import {
  Calculator as CalculatorIcon,
  CalendarDays,
  Search,
  Youtube,
  Clapperboard,
  Gamepad2,
  Compass as CompassIcon,
  Accessibility as AccessibilityIcon,
  Settings as SettingsIcon,
  GraduationCap,
  Bot,
  Map as MapIcon,
} from 'lucide-react';
import type { ReactElement } from 'react';
import type { AppId } from './apps';

export const APP_ICONS: Record<AppId, (props: { className?: string }) => ReactElement> = {
  search: (props) => <Search {...props} />,
  youtube: (props) => <Youtube {...props} />,
  calendar: (props) => <CalendarDays {...props} />,
  calculator: (props) => <CalculatorIcon {...props} />,
  theatre: (props) => <Clapperboard {...props} />,
  games: (props) => <Gamepad2 {...props} />,
  compass: (props) => <CompassIcon {...props} />,
  accessibility: (props) => <AccessibilityIcon {...props} />,
  settings: (props) => <SettingsIcon {...props} />,
  education: (props) => <GraduationCap {...props} />,
  aiAssistant: (props) => <Bot {...props} />,
  maps: (props) => <MapIcon {...props} />,
};
