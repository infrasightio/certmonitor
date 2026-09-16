/**
 * Sidebar structure. This is also the source of the previous/next order and
 * of the breadcrumb group, so a page only has to appear here once.
 */
DOCS.nav = [
  {
    title: 'Introduction',
    items: ['home', 'getting-started']
  },
  {
    title: 'Architecture',
    items: ['architecture', 'request-flow', 'database', 'background-jobs']
  },
  {
    title: 'Monitoring',
    items: ['monitoring', 'ssl', 'endpoints', 'dashboard']
  },
  {
    title: 'Operations',
    items: ['incidents', 'diagnose', 'rca', 'changes']
  },
  {
    title: 'Administration',
    items: ['users', 'configuration']
  },
  {
    title: 'Reference',
    items: ['api']
  },
  {
    title: 'Deployment',
    items: ['deployment-docker', 'deployment-kubernetes', 'troubleshooting', 'extending']
  }
];
