import { createBrowserRouter } from 'react-router';
import { adminRoutes } from './admin/routes';
import { NotFound } from './components/NotFound';
import { publicRoutes } from './public/routes';

export const router = createBrowserRouter([...publicRoutes, ...adminRoutes, { path: '*', element: <NotFound /> }]);
