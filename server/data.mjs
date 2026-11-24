export const task = {
  id: 'pipe-connection', version: 1, title: 'Assemble a practice pipe connection',
  trade: 'Plumbing', skill: 'Pipe connections',
  brief: 'Use a disconnected training rig. Name the fitting and show the assembled joint clearly. Ask your trainer to supervise the assessment.',
  criteria: [
    { id: 'identify', label: 'Identifies the fitting and pipe' },
    { id: 'assembly', label: 'Shows the fitting seated and aligned' },
    { id: 'visibility', label: 'Shows the finished joint clearly' }
  ]
};

export const localities = ['Rampur', 'Shivpur', 'Basantpur'];
export const neighbors = { Rampur: ['Shivpur'], Shivpur: ['Rampur', 'Basantpur'], Basantpur: ['Shivpur'] };
export const accounts = {
  worker: { id: 'worker', role: 'worker', name: 'Asha Verma' },
  reviewer: { id: 'reviewer', role: 'reviewer', name: 'Meera Singh' },
  employer: { id: 'employer', role: 'employer', name: 'Rampur Works' },
  teacher: { id: 'teacher', role: 'teacher', name: 'Anita Sharma' }
};
export const students = [
  { id: 'learner-a', label: 'Learner A' }, { id: 'learner-b', label: 'Learner B' }
];

export function seed() {
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const expiry = new Date(Date.now() + 14 * 86400000).toISOString();
  const job = (id, title, locality, trade, wage, skill) => ({
    id, title, employerId: 'employer', employerName: 'Rampur Works', locality, trade, wage,
    skill, wageUnit: 'day', date: tomorrow, expiry, openings: 1, status: 'open', demo: true
  });
  return {
    profiles: { worker: { name: 'Asha Verma', trade: 'Plumbing', locality: 'Rampur', language: 'en', available: true } },
    submissions: {}, reviews: {}, credentials: {}, shares: {}, applications: {}, events: {},
    jobs: Object.fromEntries([
      job('job-1', 'Plumbing assistant', 'Rampur', 'Plumbing', 700, 'Pipe connections'),
      job('job-2', 'Maintenance helper', 'Shivpur', 'Plumbing', 800, 'Pipe connections'),
      job('job-3', 'Site support assistant', 'Rampur', 'General', 650, ''),
      job('job-4', 'Materials assistant', 'Shivpur', 'General', 620, ''),
      job('job-5', 'Workshop helper', 'Basantpur', 'General', 680, '')
    ].map(item => [item.id, item]))
  };
}
