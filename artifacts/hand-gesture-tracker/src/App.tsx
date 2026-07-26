import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import VRHub from '@/vr-hub/VRHub';
import { XRHub } from '@/vr-hub/XRHub';

const queryClient = new QueryClient();

// Safe switch: normal use (koi query param nahi) mein bilkul pehle jaisa
// VRHub hi render hota hai — kuch nahi badla. Sirf jab URL me explicitly
// "?xr=true" ho (jo sirf khud test karte waqt manually type karoge), tab
// experimental WebXR wala XRHub render hota hai. Isse production/daily-use
// app kabhi bhi accidentally XR mode me nahi jaayega.
function Home() {
  const params = new URLSearchParams(window.location.search);
  const useXR = params.get('xr') === 'true';
  return useXR ? <XRHub /> : <VRHub />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
