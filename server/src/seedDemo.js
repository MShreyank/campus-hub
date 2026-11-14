// Adds reusable fictional demo accounts and realistic sample activity.
// Run from the project root with: npm run seed:demo
// Demo-only credentials; never run this against a production database.
import bcrypt from 'bcryptjs';
import { db } from './db.js';

const password = 'password123';
const passwordHash = password; // plain text (demo)

const demoUsers = [
  { email: 'admin@college.edu', username: 'admin', display_name: 'Campus Admin', role: 'admin', teacher_status: 'approved', department: 'Administration', bio: 'Keeping the campus community helpful, safe, and welcoming.' },
  { email: 'prof.rao@college.edu', username: 'prof_rao', display_name: 'Dr. Ananya Rao', role: 'teacher', teacher_status: 'approved', department: 'Computer Science', bio: 'Faculty member sharing programming resources and announcements.' },
  { email: 'prof.sharma@college.edu', username: 'prof_sharma', display_name: 'Prof. Kiran Sharma', role: 'teacher', teacher_status: 'approved', department: 'Electronics', bio: 'Interested in embedded systems, IoT, and student projects.' },
  { email: 'asha@college.edu', username: 'asha', display_name: 'Asha Kumar', role: 'student', teacher_status: 'none', department: 'Computer Science', bio: 'Learning Python and building small web projects.' },
  { email: 'ravi@college.edu', username: 'ravi', display_name: 'Ravi Shetty', role: 'student', teacher_status: 'none', department: 'Electronics', bio: 'IoT enthusiast and weekend football player.' },
  { email: 'meera@college.edu', username: 'meera', display_name: 'Meera Nair', role: 'student', teacher_status: 'none', department: 'Information Science', bio: 'Sharing study notes and hackathon updates.' },
  { email: 'arjun@college.edu', username: 'arjun', display_name: 'Arjun Patel', role: 'student', teacher_status: 'none', department: 'Mechanical', bio: 'Interested in robotics, design, and campus events.' },
  { email: 'nisha@college.edu', username: 'nisha', display_name: 'Nisha Gowda', role: 'student', teacher_status: 'none', department: 'Computer Science', bio: 'Enjoys helping classmates with data structures.' },
  { email: 'faiz@college.edu', username: 'faiz', display_name: 'Faiz Ahmed', role: 'student', teacher_status: 'none', department: 'Information Science', bio: 'Exploring UI design and full-stack development.' },
  { email: 'divya@college.edu', username: 'divya', display_name: 'Divya R', role: 'student', teacher_status: 'none', department: 'Electronics', bio: 'Working on a campus air-quality monitoring project.' },
];

const upsertUser = db.prepare(`
  INSERT INTO users (email, username, password_hash, display_name, role, teacher_status, department, bio)
  VALUES (@email, @username, @password_hash, @display_name, @role, @teacher_status, @department, @bio)
  ON CONFLICT(email) DO UPDATE SET
    username=excluded.username,
    password_hash=excluded.password_hash,
    display_name=excluded.display_name,
    role=excluded.role,
    teacher_status=excluded.teacher_status,
    department=excluded.department,
    bio=excluded.bio
`);
const getUser = db.prepare('SELECT id FROM users WHERE username = ?');
const getCommunity = db.prepare('SELECT id FROM communities WHERE name = ?');
const insertCommunity = db.prepare('INSERT OR IGNORE INTO communities (name, title, description, kind, created_by) VALUES (?,?,?,?,?)');
const joinCommunity = db.prepare("INSERT OR IGNORE INTO community_members (community_id, user_id, role) VALUES (?, ?, 'member')");
const insertPost = db.prepare(`
  INSERT INTO posts (community_id, user_id, title, body, type, pinned)
  SELECT ?, ?, ?, ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM posts WHERE community_id=? AND user_id=? AND title=?)
`);
const insertComment = db.prepare(`
  INSERT INTO comments (post_id, user_id, body)
  SELECT ?, ?, ?
  WHERE NOT EXISTS (SELECT 1 FROM comments WHERE post_id=? AND user_id=? AND body=?)
`);

const seed = db.transaction(() => {
  for (const user of demoUsers) {
    // A matching demo email is updated to keep the documented demo password reliable.
    upsertUser.run({ ...user, password_hash: passwordHash });
  }

  const userId = (username) => {
    const row = getUser.get(username);
    if (!row) throw new Error(`Demo user not found after seeding: ${username}`);
    return row.id;
  };
  const admin = userId('admin');
  const rao = userId('prof_rao');
  const sharma = userId('prof_sharma');
  const asha = userId('asha');
  const ravi = userId('ravi');
  const meera = userId('meera');
  const arjun = userId('arjun');
  const nisha = userId('nisha');
  const faiz = userId('faiz');
  const divya = userId('divya');

  insertCommunity.run('cs101', 'CS101 - Intro to Programming', 'Programming questions, notes, and assignment discussions.', 'course', rao);
  insertCommunity.run('iot-lab', 'IoT & Innovation Lab', 'Ideas, prototypes, sensors, and project collaboration.', 'club', sharma);
  insertCommunity.run('campus-events', 'Campus Events', 'Clubs, competitions, workshops, and campus activities.', 'club', admin);

  // Add all demo accounts to the default campus communities and selected groups.
  const defaultCommunities = ['announcements', 'general', 'study-help'];
  for (const name of defaultCommunities) {
    const community = getCommunity.get(name);
    if (community) for (const user of demoUsers) joinCommunity.run(community.id, userId(user.username));
  }
  const groupMembers = {
    cs101: ['prof_rao', 'asha', 'meera', 'nisha', 'faiz', 'admin'],
    'iot-lab': ['prof_sharma', 'ravi', 'divya', 'arjun', 'admin'],
    'campus-events': ['admin', 'asha', 'ravi', 'meera', 'arjun', 'nisha', 'faiz', 'divya'],
  };
  for (const [name, usernames] of Object.entries(groupMembers)) {
    const community = getCommunity.get(name);
    if (!community) continue;
    for (const username of usernames) joinCommunity.run(community.id, userId(username));
  }
  // Mark the course instructor as a moderator.
  const cs = getCommunity.get('cs101');
  if (cs) db.prepare("UPDATE community_members SET role='mod' WHERE community_id=? AND user_id=?").run(cs.id, rao);
  const iot = getCommunity.get('iot-lab');
  if (iot) db.prepare("UPDATE community_members SET role='mod' WHERE community_id=? AND user_id=?").run(iot.id, sharma);

  const postData = [
    ['announcements', 'prof_rao', 'Mid-semester examination timetable', 'Mid-semester examinations begin next Monday. Please check the department notice board for the final timetable and arrive 15 minutes early.', 'announcement', 1],
    ['general', 'ravi', 'Football this Saturday?', 'A few of us are planning a friendly match on the main ground at 4:00 PM this Saturday. Comment if you want to join!', 'discussion', 0],
    ['study-help', 'asha', 'Quick revision: lists vs tuples in Python', 'Can someone share a simple example that explains when to use a list and when to use a tuple?', 'question', 0],
    ['cs101', 'nisha', 'Tips for preparing for the data structures lab', 'I am revising stacks, queues, and linked lists this week. What are the most common mistakes to watch for in lab programs?', 'question', 0],
    ['cs101', 'prof_rao', 'Python practice resources', 'Start with functions, lists, dictionaries, and file handling. Try writing a small program yourself before looking at a solution.', 'resource', 0],
    ['iot-lab', 'divya', 'Air quality monitor prototype update', 'Our prototype reads air-quality and temperature values. Next we want to display the readings on an LCD and plot them on a dashboard.', 'discussion', 0],
    ['iot-lab', 'prof_sharma', 'IoT lab open session', 'The lab will be open on Friday afternoon for students who want to test ESP32 boards and sensors. Bring your project notes.', 'announcement', 0],
    ['campus-events', 'meera', 'Ideas for the next coding club meetup', 'Would people prefer a beginner-friendly web development workshop, a Python challenge, or a mini hackathon?', 'discussion', 0],
    ['campus-events', 'arjun', 'Project showcase registrations', 'If you are building a prototype or software project, share a short title and your team size here. We are collecting ideas for a student showcase.', 'discussion', 0],
    ['general', 'faiz', 'Looking for feedback on a UI design', 'I am redesigning a student dashboard. Which matters most to you: quick navigation, a clear activity feed, or notifications?', 'question', 0],
  ];
  for (const [communityName, username, title, body, type, pinned] of postData) {
    const community = getCommunity.get(communityName);
    if (community) insertPost.run(community.id, userId(username), title, body, type, pinned, community.id, userId(username), title);
  }

  const getPost = db.prepare('SELECT id FROM posts WHERE title=? ORDER BY id DESC LIMIT 1');
  const commentData = [
    ['Quick revision: lists vs tuples in Python', 'ravi', 'Lists can be changed after creation; tuples are immutable. Use a list for items you expect to add or remove.'],
    ['Quick revision: lists vs tuples in Python', 'prof_rao', 'Good explanation. Also practise indexing, slicing, and looping through both types.'],
    ['Air quality monitor prototype update', 'arjun', 'Nice project! Consider adding a threshold alert when the sensor reading goes above your chosen limit.'],
    ['Ideas for the next coding club meetup', 'nisha', 'A short workshop followed by a mini challenge would be fun for beginners.'],
    ['Looking for feedback on a UI design', 'asha', 'A clear activity feed and easy navigation would help me find updates quickly.'],
  ];
  for (const [title, username, body] of commentData) {
    const post = getPost.get(title);
    if (post) insertComment.run(post.id, userId(username), body, post.id, userId(username), body);
  }

  // Keep the post comment counters consistent with seeded comments.
  db.prepare('UPDATE posts SET comment_count=(SELECT COUNT(*) FROM comments WHERE comments.post_id=posts.id) WHERE id IN (SELECT DISTINCT post_id FROM comments)').run();
});

seed();
console.log('Demo data ready. Login with any account below; password for all is: ' + password);
for (const user of demoUsers) console.log(`  ${user.role.padEnd(7)} ${user.username.padEnd(12)} ${user.email}`);
console.log('Seeding is repeatable and will not duplicate the demo posts/comments.');
