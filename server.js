/**
 * Bug Tracker — Standalone cross-project bug submission service.
 *
 * Auto-scans workspace/projects/ + ~/projects/ for any project
 * that has a bugs/ folder, and lets you submit bugs to any of them.
 *
 * Port: 3003 (configurable via PORT env)
 */

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3003;

// ---- Paths ----
const WORKSPACE_PROJECTS = path.resolve(__dirname, '..');
const HOME_PROJECTS = path.resolve(os.homedir(), 'projects');
const PUBLIC_DIR = path.join(__dirname, 'public');

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ---- Find project directory across both locations ----
function findProjectDir(projectId) {
  const candidates = [
    path.join(WORKSPACE_PROJECTS, projectId),
    path.join(HOME_PROJECTS, projectId),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

// ---- Multer for screenshot uploads ----
const upload = multer({
  storage: multer.diskStorage({
    destination: function (req, file, cb) {
      const project = req.body.project;
      if (!project) return cb(new Error('Missing project'));
      const projectDir = findProjectDir(project);
      if (!projectDir) return cb(new Error('Project not found'));
      const dir = path.join(projectDir, 'bugs', 'screenshots');
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
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.txt', '.json', '.csv', '.log'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not allowed`));
    }
  },
});

// ---- Helpers ----

function scanProjects() {
  const projects = [];
  const seen = new Set();

  function addFrom(baseDir) {
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || seen.has(entry.name)) continue;
        seen.add(entry.name);
        projects.push({
          id: entry.name,
          name: entry.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        });
      }
    } catch (err) { /* skip */ }
  }

  addFrom(WORKSPACE_PROJECTS);
  addFrom(HOME_PROJECTS);
  return projects;
}

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
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const tzHours = pad(Math.floor(Math.abs(offset) / 60));
  const tzMins = pad(Math.abs(offset) % 60);
  const tzLabel = offset === 0 ? 'UTC' : `UTC${sign}${tzHours}:${tzMins}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${tzLabel})`;
}

function severityEmoji(severity) {
  const map = { critical: '🔴 Critical', high: '🟠 High', medium: '🟡 Medium', low: '🟢 Low' };
  return map[severity] || '🟡 Medium';
}

function statusEmoji(status) {
  const map = { new: '[ ] New', done: '[x] Done', cancelled: '[~] Cancelled', in_progress: '[→] In Progress' };
  return map[status] || '[ ] New';
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

/**
 * Parse a bug markdown file to extract structured info.
 */
function parseBugFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const filename = path.basename(filePath);

  // Extract bug ID from filename
  const idMatch = filename.match(/^(BUG[-_](\d+))/i);
  const bugId = idMatch ? idMatch[1] : filename;
  const bugNum = idMatch ? parseInt(idMatch[2], 10) : 0;

  // Extract title
  const titleMatch = content.match(/^#\s+\[\w+-\d+\]\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : filename.replace(/\.md$/, '');

  // Extract status
  const statusMatch = content.match(/\*{0,2}Status\*{0,2}\s*\|\s*`\[\s*([x~→ ])\]\s*(.+?)`/i);
  let status = 'new';
  if (statusMatch) {
    const marker = statusMatch[1];
    if (marker === 'x' || marker === 'X') status = 'done';
    else if (marker === '~') status = 'cancelled';
  }

  // Extract severity
  const severityMatch = content.match(/Severity\s*\|\s*(.+)/);
  let severity = 'medium';
  if (severityMatch) {
    const sev = severityMatch[1].toLowerCase();
    if (sev.includes('critical')) severity = 'critical';
    else if (sev.includes('high')) severity = 'high';
    else if (sev.includes('low')) severity = 'low';
  }

  // Extract fields
  const extractField = (label) => {
    const re = new RegExp(`\\*\\*${label}\\*\\*\\s*\\|\\s*(.+)`);
    const m = content.match(re);
    return m ? m[1].trim() : '';
  };

  // Extract screenshots
  const screenshots = [];
  const screenshotRe = /!\[Screenshot\]\(screenshots\/(.+?)\)/g;
  let sm;
  while ((sm = screenshotRe.exec(content)) !== null) {
    screenshots.push(sm[1]);
  }

  // Extract Eva2 notes
  const notesMatch = content.match(/## Eva2 Notes\n\n[\s\S]*$/);
  let eva2Notes = '';
  if (notesMatch) {
    eva2Notes = notesMatch[0];
  }

  return {
    id: bugId,
    number: bugNum,
    filename,
    title,
    status,
    severity,
    reported_by: extractField('Reported by'),
    date: extractField('Date'),
    page_route: extractField('Page/Route'),
    browser: extractField('Browser'),
    device: extractField('Device'),
    steps: content,
    hasNotes: eva2Notes.length > 0,
    screenshots,
  };
}

/**
 * Parse status from bug file content.
 */
function parseBugStatus(content) {
  const m = content.match(/\*{0,2}Status\*{0,2}\s*\|\s*`\[\s*([x~→ ])\]\s*(.+?)`/i);
  if (!m) return 'new';
  if (m[1] === 'x' || m[1] === 'X') return 'done';
  if (m[1] === '~') return 'cancelled';
  return 'new';
}

// ---- API Routes ----

app.get('/api/projects', function (req, res) {
  const projects = scanProjects();
  res.json({ projects });
});

/**
 * GET /api/projects/:projectId/bugs
 * Returns all bugs for a project.
 */
app.get('/api/projects/:projectId/bugs', function (req, res) {
  const projectDir = findProjectDir(req.params.projectId);
  if (!projectDir) return res.status(404).json({ error: 'Project not found' });

  const bugsDir = path.join(projectDir, 'bugs');
  try {
    const files = fs.readdirSync(bugsDir).filter(f => /^BUG[-_]\d+/i.test(f) && f.endsWith('.md'));
    const bugs = files.map(f => parseBugFile(path.join(bugsDir, f)));
    bugs.sort((a, b) => b.number - a.number); // newest first
    res.json({ bugs, project: req.params.projectId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/projects/:projectId/bugs/:bugId
 * Returns full content of a single bug.
 */
app.get('/api/projects/:projectId/bugs/:bugId', function (req, res) {
  const projectDir = findProjectDir(req.params.projectId);
  if (!projectDir) return res.status(404).json({ error: 'Project not found' });

  const bugsDir = path.join(projectDir, 'bugs');
  const files = fs.readdirSync(bugsDir).filter(f =>
    f.toLowerCase().startsWith(req.params.bugId.toLowerCase()) && f.endsWith('.md')
  );
  if (files.length === 0) return res.status(404).json({ error: 'Bug not found' });
  const filePath = path.join(bugsDir, files[0]);
  const bug = parseBugFile(filePath);
  res.json({ bug, content: fs.readFileSync(filePath, 'utf-8') });
});

/**
 * PATCH /api/projects/:projectId/bugs/:bugId
 * Update bug status or content.
 * Body (status update): { status: 'new' | 'done' | 'cancelled' | 'in_progress' }
 * Body (content update): { content: '<full markdown content>' }
 */
app.patch('/api/projects/:projectId/bugs/:bugId', function (req, res) {
  const { status, content } = req.body;

  const projectDir = findProjectDir(req.params.projectId);
  if (!projectDir) return res.status(404).json({ error: 'Project not found' });

  const bugsDir = path.join(projectDir, 'bugs');
  const files = fs.readdirSync(bugsDir).filter(f =>
    f.toLowerCase().startsWith(req.params.bugId.toLowerCase()) && f.endsWith('.md')
  );
  if (files.length === 0) return res.status(404).json({ error: 'Bug not found' });

  const filePath = path.join(bugsDir, files[0]);

  // Content update mode
  if (content !== undefined && status === undefined) {
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`[bug-tracker] ${req.params.bugId} → content updated`);
    return res.json({ success: true, bug: req.params.bugId, file: files[0] });
  }

  // Status update mode
  const validStatuses = ['new', 'done', 'cancelled', 'in_progress'];
  if (!validStatuses.includes(status)) {
    return res.status(422).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }

  let fileContent = fs.readFileSync(filePath, 'utf-8');

  // Map status to markdown marker
  const markerMap = { new: ' ', done: 'x', cancelled: '~', in_progress: '→' };
  const marker = markerMap[status];
  const labelMap = { new: 'New', done: 'Done', cancelled: 'Cancelled', in_progress: 'In Progress' };
  const label = labelMap[status];

  // Replace status line: `[ ] New` → `[x] Done` etc.
  fileContent = fileContent.replace(
    /(\*\*Status\*\*\s*\|\s*`\[)\s*([x~→ ])\]\s*(.+?)`/i,
    `$1${marker}] ${label}\` `
  );

  // Also update inline in the Eva2 Notes area if status changed to done/cancelled
  if (status === 'done') {
    if (!fileContent.includes('| **Fix commit** |')) {
      const date = formatDate();
      fileContent += `\n\n_Eva2 auto-marked as ${label} on ${date}_\n`;
    }
  }

  fs.writeFileSync(filePath, fileContent, 'utf-8');
  console.log(`[bug-tracker] ${req.params.bugId} → status=${status}`);

  res.json({ success: true, bug: req.params.bugId, status, file: files[0] });
});

/**
 * POST /api/projects/:projectId/bugs/:bugId/move
 * Move a bug to a different project (copy file + screenshots, update number, delete original).
 * Body: { targetProject: 'projectId' }
 */
app.post('/api/projects/:projectId/bugs/:bugId/move', function (req, res) {
  const { targetProject } = req.body;
  if (!targetProject) return res.status(422).json({ error: 'targetProject is required' });

  const sourceDir = findProjectDir(req.params.projectId);
  const targetDir = findProjectDir(targetProject);
  if (!sourceDir) return res.status(404).json({ error: 'Source project not found' });
  if (!targetDir) return res.status(404).json({ error: 'Target project not found' });

  const sourceBugsDir = path.join(sourceDir, 'bugs');
  const targetBugsDir = path.join(targetDir, 'bugs');
  const targetScreenshotsDir = path.join(targetBugsDir, 'screenshots');

  // Find source bug file
  const files = fs.readdirSync(sourceBugsDir).filter(f =>
    f.toLowerCase().startsWith(req.params.bugId.toLowerCase()) && f.endsWith('.md')
  );
  if (files.length === 0) return res.status(404).json({ error: 'Bug not found' });

  const sourceFile = files[0];
  const sourcePath = path.join(sourceBugsDir, sourceFile);
  let content = fs.readFileSync(sourcePath, 'utf-8');

  // Parse current bug number from filename
  const numMatch = sourceFile.match(/^BUG[-_]?(\d+)/i);
  const sourceNum = numMatch ? parseInt(numMatch[1], 10) : 1;

  // Get next bug number in target project
  const targetNextNum = getNextBugNumber(targetBugsDir);
  const paddedTarget = String(targetNextNum).padStart(3, '0');

  // Extract original title for slug
  const titleMatch = content.match(/^#\s+\[\w+-\d+\]\s+(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : sourceFile.replace(/\.md$/, '').replace(/^BUG-\d+-/, '');
  const slug = slugify(title);
  const newFilename = `BUG-${paddedTarget}-${slug}.md`;

  // Update bug ID in content
  content = content.replace(
    /^(#\s*\[)BUG-\d+(\].*)/m,
    `$1BUG-${paddedTarget}$2`
  );
  // Add move note
  const date = formatDate();
  content += `\n\n_Moved from ${req.params.projectId} (BUG-${String(sourceNum).padStart(3, '0')}) on ${date}_\n`;

  // Create target dirs
  fs.mkdirSync(targetBugsDir, { recursive: true });
  fs.mkdirSync(targetScreenshotsDir, { recursive: true });

  // Copy screenshots, renaming with new bug number
  const movedScreenshots = [];
  const screenshotRe = /!\[Screenshot\]\(screenshots\/(.+?)\)/g;
  let sm;
  while ((sm = screenshotRe.exec(content)) !== null) {
    const oldShot = sm[1];
    const newShot = oldShot.replace(/^BUG-\d+-/, `BUG-${paddedTarget}-`);
    const oldShotPath = path.join(sourceBugsDir, 'screenshots', oldShot);
    const newShotPath = path.join(targetScreenshotsDir, newShot);
    if (fs.existsSync(oldShotPath)) {
      fs.copyFileSync(oldShotPath, newShotPath);
    }
    movedScreenshots.push(newShot);
    // Update screenshot refs in content
    content = content.replace(
      `![Screenshot](screenshots/${oldShot})`,
      `![Screenshot](screenshots/${newShot})`
    );
  }

  // Write new bug file to target
  const targetPath = path.join(targetBugsDir, newFilename);
  fs.writeFileSync(targetPath, content, 'utf-8');

  // Delete original source file
  fs.unlinkSync(sourcePath);
  // Clean up orphaned screenshots in source project (files no longer referenced by any bug)
  try {
    const remainingBugs = fs.readdirSync(sourceBugsDir).filter(f => f.endsWith('.md'));
    const allReferenced = new Set();
    for (const bf of remainingBugs) {
      const bc = fs.readFileSync(path.join(sourceBugsDir, bf), 'utf-8');
      const refRe = /!\[Screenshot\]\(screenshots\/(.+?)\)/g;
      let rm;
      while ((rm = refRe.exec(bc)) !== null) allReferenced.add(rm[1]);
    }
    const shotDir = path.join(sourceBugsDir, 'screenshots');
    if (fs.existsSync(shotDir)) {
      for (const f of fs.readdirSync(shotDir)) {
        if (!allReferenced.has(f)) {
          fs.unlinkSync(path.join(shotDir, f));
        }
      }
    }
  } catch (e) { /* best effort */ }

  console.log(`[bug-tracker] Moved ${req.params.bugId} → ${targetProject}/BUG-${paddedTarget}`);

  res.json({
    success: true,
    original: { project: req.params.projectId, bug_id: req.params.bugId },
    moved: { project: targetProject, bug_id: `BUG-${paddedTarget}`, file: newFilename },
    screenshots_moved: movedScreenshots.length,
  });
});

/**
 * POST /api/submit
 * Submit a bug to a specific project.
 */
app.post('/api/submit', upload.array('screenshots', 5), function (req, res) {
  try {
    const body = req.body;
    const project = body.project;

    const projectDir = findProjectDir(project);
    if (!projectDir) return res.status(404).json({ error: 'Project not found' });

    const bugsDir = path.join(projectDir, 'bugs');
    const screenshotsDir = path.join(bugsDir, 'screenshots');
    fs.mkdirSync(screenshotsDir, { recursive: true });

    if (!body.title || !body.title.trim()) {
      return res.status(422).json({ error: 'validation_error', fields: ['title'], message: 'Title is required' });
    }

    const bugNumber = getNextBugNumber(bugsDir);
    const padded = String(bugNumber).padStart(3, '0');
    const slug = slugify(body.title);
    const bugFilename = `BUG-${padded}-${slug}.md`;

    const screenshotRefs = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const oldName = file.filename;
        const newName = oldName.replace(/^BUG-XXX-/, `BUG-${padded}-`);
        const oldPath = path.join(screenshotsDir, oldName);
        const newPath = path.join(screenshotsDir, newName);
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
        screenshotRefs.push(newName);
      }
    }

    const md = generateBugMd(bugNumber, body, screenshotRefs);
    fs.writeFileSync(path.join(bugsDir, bugFilename), md, 'utf-8');

    console.log(`[bug-tracker] BUG-${padded} → ${project}/${bugFilename}`);

    res.status(201).json({
      success: true,
      project,
      bug_number: bugNumber,
      bug_id: `BUG-${padded}`,
      file: `${project}/bugs/${bugFilename}`,
      screenshots: screenshotRefs.length,
      message: `Bug submitted to ${project}. Tell Eva2 when you're done testing!`,
    });
  } catch (err) {
    console.error('[bug-tracker] Submit error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message || 'Failed to submit bug' });
  }
});

// ---- Start ----

app.listen(PORT, function () {
  console.log(`🐛 Bug Tracker running on http://localhost:${PORT}`);

  const projects = scanProjects();
  if (projects.length === 0) {
    console.log('   ⚠ No projects with bugs/ found.');
  } else {
    console.log(`   📁 ${projects.length} project(s) available:`);
    for (const p of projects) {
      console.log(`      • ${p.id}`);
    }
  }
});
