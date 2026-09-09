import { Accessibility } from 'lucide-react';
import { ComingSoonApp } from './ComingSoonApp';

// Blind Assist / accessibility mode. Real functionality (camera ->
// coco-ssd object detection -> voice-guided direction/danger alerts)
// gets implemented inside this component later — this is just the
// registered placeholder shell for now.
export function AccessibilityApp() {
  return (
    <ComingSoonApp
      title="Accessibility"
      description="Voice-guided object detection is on its way."
      icon={Accessibility}
    />
  );
}
