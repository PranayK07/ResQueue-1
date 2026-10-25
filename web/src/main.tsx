import '@/index.css';
import { MotionConfig } from 'motion/react';
import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Navigate, Outlet, createBrowserRouter, useLocation, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { APP_NAME } from '@/lib/app';
import { AnchorOverlay, anchorsOverlayRequested } from '@/lib/guide';
import { StdbProvider } from '@/lib/stdb';
import { Toaster } from '@/lib/ui/sonner';
import { TooltipProvider } from '@/lib/ui/tooltip';
import { CommandPage } from '@/routes/command/CommandPage';
import { CrewPage } from '@/routes/crew/CrewPage';
import { HelpPage } from '@/routes/help/HelpPage';

// Dev-only route. The import sits inside the DEV branch so production builds drop it entirely.
function devRoutes(): RouteObject[] {
  if (!import.meta.env.DEV) return [];
  const DebugPage = lazy(() => import('@/routes/debug/DebugPage'));
  return [
    {
      path: '_debug',
      element: (
        <Suspense fallback={null}>
          <DebugPage />
        </Suspense>
      ),
    },
  ];
}

function Root() {
  const { pathname, search } = useLocation();
  // On /help the guide layer (overlay included) exists only in demo mode.
  const anchors = anchorsOverlayRequested(search) && (!pathname.startsWith('/help') || new URLSearchParams(search).get('demo') === '1');
  return (
    <>
      <Outlet />
      {anchors && <AnchorOverlay />}
      <Toaster position="top-center" />
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      { index: true, element: <Navigate to="/help" replace /> },
      {
        path: 'help',
        element: (
          <StdbProvider surface="help">
            <HelpPage />
          </StdbProvider>
        ),
      },
      {
        path: 'command',
        element: (
          <StdbProvider surface="command">
            <CommandPage />
          </StdbProvider>
        ),
      },
      {
        path: 'crew',
        element: (
          <StdbProvider surface="crew">
            <CrewPage />
          </StdbProvider>
        ),
      },
      ...devRoutes(),
      { path: '*', element: <Navigate to="/help" replace /> },
    ],
  },
]);

document.title = APP_NAME;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <TooltipProvider delayDuration={300}>
        <RouterProvider router={router} />
      </TooltipProvider>
    </MotionConfig>
  </StrictMode>
);
