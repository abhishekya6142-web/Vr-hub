import { Calculator as CalculatorIcon, CalendarDays, Search, Youtube, Clapperboard } from 'lucide-react';
import type { ReactElement } from 'react';
import type { AppId } from './apps';

// Central icon lookup so the same glyph is used consistently on the home
// screen grid and the dock's "currently open" indicator.
export const APP_ICONS: Record<AppId, (props: { className?: string }) => ReactElement> = {
  search: (props) => <Search {...props} />,
  youtube: (props) => <Youtube {...props} />,
  calendar: (props) => <CalendarDays {...props} />,
  calculator: (props) => <CalculatorIcon {...props} />,
  theatre: (props) => <Clapperboard {...props} />,
};
