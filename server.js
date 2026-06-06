/**
 * Bug Tracker — Standalone cross-project bug submission service.
 *
 * Auto-scans /home/dell/.openclaw/workspace/projects/ for any project
 * that has a bugs/ folder, and lets you submit bugs to any of them.
 *
 * Port: 3003 (configurable via PORT env)
 *
 * Workflow:
 *   1. Open http://localhost:3003
 *   2. Choose a project (ely, smart_learn, ...)
 *   3. Fill in bug details + drag screenshots
 *   4. Submit → saved to that project's bugs/ folder
 *   5. When done testing, check everything into GitHub
 *   6. Tell Eva2 "I completed [project] test"
 *   7. Eva2 pulls latest, reads all [ ] New bugs, fixes them
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3003;

// ---- Paths ----
const WORKSPACE_PROJECTS = path.resolve(__dirname, '..');
// The form is served from public/
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ---- Multer for screenshot uploads ----
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      // Screenshots go into the target project's bugs/screenshots/
      const project = req.body.project;
      if (!project) return cb(new Error('Missing project'));
      const dir = path.join(WORKSPACE_PROJECTS, project, 'bugs', 'screenshots');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname) || '.png';
      const base = path.basename(file.originalname, ext)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 50);
      cb(null, `BUG-XXX-${base}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  },
});

// ---- Helpers ----

/**
 * Scan workspace/projects/ for directories that contain a bugs/ subfolder.
 * Returns [{ id, name, path }]
 */
function scanProjects() {
  const projects = [];
  try {
    const entries = fs.readdirSync(WORKSPACE_PROJECTS, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'bug-tracker') continue;
      // Show all projects — bugs/ folder will be auto-created on first submission
      projects.push({
        id: entry.name,
        name: entry.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        path: path.join(WORKSPACE_PROJECTS, entry.name),
      });
    }
  } catch (err) {
    console.error('[bug-tracker] Error scanning projects:', err.message);
  }
  return projects;
}

/**
 * Determine next bug number for a project.
 */
function getNextBugNumber(bugsDir) {
  try {
    const files = fs.readdirSync(bugsDir).filter(f => /^BUG[-_](\d+)/i.test(f));
    let max = 0;
    for (const f of files) {
      const match = f.match(/^BUG[-_](\d+)/i);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > max) max = num;
      }
    }
    return max + 1;
  } catch {
    return 1;
  }
}

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

function formatDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function severityEmoji(severity) {
  const map = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' };
  return map[severity] || '🟡 Medium';
}

function generateBugMd(bugNumber, data, screenshotRefs) {
  const emoji = severityEmoji(data.severity);
  const date = formatDate();

  let screenshotsSection = '';
  if (screenshotRefs.length > 0) {
    screenshotsSection = '\n## Screenshots\n\n';
    for (const ref of screenshotRefs) {
      screenshotsSection += `![Screenshot](screenshots/${ref})\n`;
    }
  }

  let consoleErrors = '';
  if (data.console_errors && data.console_errors.trim()) {
    consoleErrors = `\n## Console Errors\n\n\`\`\`\n${data.console_errors.trim()}\n\`\`\`\n`;
  }

  const padded = String(bugNumber).padStart(3, '0');
  return `# [BUG-${padded}] ${data.title}

| Field | Value |
|-------|-------|
| **Status** | \`[ ] New\` |
| **Reported by** | ${data.reported_by || 'Bug Reporter'} |
| **Date** | ${date} |
| **Severity** | ${emoji} |
| **Page/Route** | \`${data.page_route || 'N/A'}\` |
| **Browser** | ${data.browser || 'N/A'} |
| **Device** | ${data.device || 'N/A'} |

---

## Steps to Reproduce

${data.steps || '1. '}

---

## Expected Behavior

${data.expected || '> What should happen'}

---

## Actual Behavior

${data.actual || '> What actually happens'}
${screenshotsSection}
${consoleErrors}
---

## Suggested Fix

${data.suggested_fix || '<!-- None provided -->'}

---

## Eva2 Notes

| Field | Value |
|-------|-------|
| **Fix commit** | |
| **Resolution** | |
| **Time spent** | |
`;
}

// ---- API Routes ----

/**
 * GET /api/projects
 * Returns list of projects that have a bugs/ folder.
 */
app.get('/api/projects', function (req, res) {
  const projects = scanProjects();
  res.json({ projects });
});

/**
 * POST /api/submit
 * Submit a bug to a specific project.
 */
app.post('/api/submit', upload.array('screenshots', 5), function (req, res) {
  try {
    const body = req.body;
    const project = body.project;

    // Ensure bugs/ directory exists (auto-create on first submission)
    const projectPath = path.join(WORKSPACE_PROJECTS, project);
    const bugsDir = path.join(projectPath, 'bugs');
    const screenshotsDir = path.join(bugsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    // Validate title
    if (!body.title || !body.title.trim()) {
      return res.status(422).json({ error: 'validation_error', fields: ['title'], message: 'Title is required' });
    }

    // Determine bug number
    const bugNumber = getNextBugNumber(bugsDir);
    const padded = String(bugNumber).padStart(3, '0');
    const slug = slugify(body.title);
    const bugFilename = `BUG-${padded}-${slug}.md`;

    // Rename screenshots
    const screenshotRefs = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const oldName = file.filename;
        const newName = oldName.replace(/^BUG-XXX-/, `BUG-${padded}-`);
        const oldPath = path.join(projectPath, 'bugs', 'screenshots', oldName);
        const newPath = path.join(projectPath, 'bugs', 'screenshots', newName);
        if (fs.existsSync(oldPath)) {
          fs.renameSync(oldPath, newPath);
        }
        screenshotRefs.push(newName);
      }
    }

    // Write bug file
    const md = generateBugMd(bugNumber, body, screenshotRefs);
    const bugPath = path.join(bugsDir, bugFilename);
    fs.writeFileSync(bugPath, md, 'utf-8');

    console.log(`[bug-tracker] BUG-${padded} → ${project}/${bugFilename}`);

    res.status(201).json({
      success: true,
      project: project,
      bug_number: bugNumber,
      bug_id: `BUG-${padded}`,
      file: `${project}/bugs/${bugFilename}`,
      screenshots: screenshotRefs.length,
      message: `Bug submitted to ${project}. Tell Eva2 when you're done testing!`,
    });
  } catch (err) {
    console.error('[bug-tracker] Submit error:', err);
    res.status(500).json({
      error: 'internal_error',
      message: err.message || 'Failed to submit bug',
    });
  }
});

// ---- Start ----

app.listen(PORT, function () {
  console.log(`🐛 Bug Tracker running on http://localhost:${PORT}`);

  const projects = scanProjects();
  if (projects.length === 0) {
    console.log('   ⚠ No projects with bugs/ folder found yet.');
    console.log('   Add a bugs/ folder to any project in workspace/projects/');
  } else {
    console.log(`   📁 ${projects.length} project(s) available:`);
    for (const p of projects) {
      console.log(`      • ${p.id} → ${p.path}/bugs/`);
    }
  }

  console.log('\n   Workflow:');
  console.log('   1. Open the form → submit bugs');
  console.log('   2. Check everything into GitHub');
  console.log('   3. Tell Eva2 "I completed [project] test"');
  console.log('   4. Eva2 pulls latest + fixes all new bugs');
});
