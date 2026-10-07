/* ============================================================
   KARE CSE - Department Social Media Management System
   Database-backed browser client
   ============================================================ */

var posts = [];
var users = [];
var registrations = [];
var scannerPost = null;

var activity = [];
var notifications = [];
var notificationUserId = null;
var lastNotificationToastId = null;
var analyticsData = { summary: { total_likes: 0, general_users: 0, published_posts: 0 }, posts: [] };
var googleCalendar = { connected: false, email: null };
var calendarNow = new Date();

var ROLE_INFO = {
  faculty: { label: "Faculty", name: "Faculty", initials: "F" },
  coordinator: { label: "Student Coordinator", name: "Coordinator", initials: "C" },
  admin: { label: "Administrator", name: "Administrator", initials: "A" },
  general: { label: "General User", name: "General User", initials: "G" }
};

var currentRole = null;
var currentUser = null;
var currentPage = "dashboard";
var reviewId = null;
var notificationReadTimer = null;
var workflowRefreshTimer = null;
var submitInFlight = false;
var similarityInFlight = false;
var captionInFlight = false;
var descriptionInFlight = false;
var decisionInFlight = false;
var ragChatInFlight = false;
var notificationsClearInFlight = false;
var ragChatHistory = [];
var API_BASE = window.location.protocol === "file:" ||
  window.location.port === "8082" ||
  window.location.port === "5173" ||
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1" ||
  window.location.hostname === "::1"
  ? "http://localhost:3001"
  : "";

var TEMPLATE_POSTERS = [
  { name: "Inauguration", file: "inauguration.jpg.jpg" },
  { name: "Workshop", file: "workshop.jpg.jpg" },
  { name: "Alumni Meet", file: "alumni-meet.jpg.jpg" },
  { name: "Hackathon", file: "hackathon.jpg.jpg" },
  { name: "Student Achievement", file: "student-achievement.jpg.jpg" },
  { name: "Placement Drive", file: "placement-drive.jpg.jpg" },
  { name: "Freshers Orientation", file: "freshers-orientation.jpg.jpg" },
  { name: "Department Celebrations", file: "department-celebrations.jpg.webp" }
];

/* ---------- helpers ---------- */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
function badge(status) {
  var map = { pending: "Pending", approved: "Approved", rejected: "Rejected", scheduled: "In Calendar", draft: "Draft" };
  return '<span class="badge ' + status + '">' + map[status] + "</span>";
}
function countBy(status) { return posts.filter(function (p) { return p.status === status; }).length; }
function isPublicEvent(p) { return p.status === "approved" || p.status === "scheduled"; }
function calendarDateWindow() {
  var start = new Date(calendarNow.getFullYear(), calendarNow.getMonth(), calendarNow.getDate());
  return { start: start };
}
function isCalendarEvent(p) {
  var date = postDate(p);
  var window = calendarDateWindow();
  return isPublicEvent(p) && date && date >= window.start;
}
async function loadCalendarWindow() {
  try {
    var response = await fetch(API_BASE + "/api/calendar-window");
    var result = await response.json();
    if (!response.ok || !result.currentDate) throw new Error("Calendar date unavailable.");
    var parts = String(result.currentDate).slice(0, 10).split("-").map(Number);
    if (parts.length === 3 && parts.every(function (part) { return Number.isFinite(part); })) {
      calendarNow = new Date(parts[0], parts[1] - 1, parts[2]);
    }
  } catch (error) {
    calendarNow = new Date();
    console.warn("Server calendar date unavailable; using the browser date.", error);
  }
}
function getLikeCount(postId) {
  var post = posts.find(function (item) { return String(item.id) === String(postId); });
  return post ? Number(post.likesCount || 0) : 0;
}
function hasUserLikedPost(postId) {
  var post = posts.find(function (item) { return String(item.id) === String(postId); });
  return !!(post && post.liked);
}
function addActivity(text) {
  activity.unshift({ t: text, s: "Just now" });
  activity = activity.slice(0, 12);
}
function markNotificationsRead() {
  if (!currentRole) return;
  notifications.forEach(function (item) {
    if (!item.forRoles || item.forRoles.indexOf(currentRole) === -1) return;
    if (item.readBy && item.readBy.indexOf(currentRole) === -1) item.readBy.push(currentRole);
    item.read = true;
  });
}
var toastTimer;
function toast(msg) {
  var el = $("#toast");
  el.innerHTML = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove("show"); }, 3200);
}

function openRegistration() { $("#registerModal").classList.add("open"); }
function closeRegistration() { $("#registerModal").classList.remove("open"); }

async function registerGeneral(e) {
  if (e) e.preventDefault();
  var password = $("#registerPassword").value;
  if (password !== $("#registerConfirmPassword").value) {
    toast("Passwords do not match.");
    return false;
  }
  try {
    var email = $("#registerEmail").value;
    var response = await fetch(API_BASE + "/api/register-general", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: $("#registerName").value,
        email: $("#registerEmail").value,
        password: password
      })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Registration failed.");
    closeRegistration();
    $("#registerForm").reset();
    $("#loginId").value = email;
    $("#loginRole").value = "general";
    toast("Registration successful. You can now log in as General.");
  } catch (error) {
    toast(error.message);
  }
  return false;
}

/* ---------- login / logout ---------- */
async function doLogin(e) {
  if (e) e.preventDefault();
  var role = $("#loginRole").value;
  var id = $("#loginId").value.trim();
  var password = $("#loginPass").value;
  if (!id || !password) {
    toast("Enter your email and password.");
    return false;
  }

  try {
    var response = await fetch(API_BASE + "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: id, password: password, role: role })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Login failed.");
    currentUser = result.user;
    localStorage.setItem("kareCurrentUser", JSON.stringify(currentUser));
    localStorage.setItem("kareCurrentRole", role);
  } catch (error) {
    toast("Login failed. Start the API and check your database details.");
    console.error(error);
    return false;
  }

  currentRole = role;
  loadRagHistory();

  await loadPublicPosts();
  if (role === "general") {
    await loadRegistrations();
    await loadGoogleCalendarStatus();
  }
  if (["faculty", "coordinator", "admin"].includes(role)) await loadWorkflowPosts();
  if (role === "admin") await loadUsers();
  await loadAnalytics();
  await loadNotifications();
  $("#screen-login").classList.remove("active");
  $("#screen-app").classList.add("active");
  buildShell(role);
  startLiveWorkflowRefresh();
  toast("Signed in as <b>" + ROLE_INFO[role].label + "</b>");
  return false;
}

async function loadGoogleCalendarStatus() {
  if (!currentUser || currentRole !== "general") return;
  try {
    var response = await fetch(API_BASE + "/api/google-calendar/status?userId=" + encodeURIComponent(currentUser.id));
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Calendar status unavailable.");
    googleCalendar = result;
    renderGoogleCalendarStatus();
  } catch (error) {
    console.warn("Google Calendar status unavailable.", error);
  }
}

function renderGoogleCalendarStatus() {
  var status = $("#googleCalendarStatus");
  var account = $("#googleCalendarAccount");
  var connect = $("#connectGoogleCalendarButton");
  var disconnect = $("#disconnectGoogleCalendarButton");
  if (!status || !account || !connect || !disconnect) return;
  status.textContent = googleCalendar.connected ? "Connected" : "Not connected";
  status.className = "badge " + (googleCalendar.connected ? "approved" : "draft");
  account.textContent = googleCalendar.connected
    ? "Connected Google account: " + googleCalendar.email
    : "Connect your Google account to add registered events to your personal calendar.";
  connect.hidden = googleCalendar.connected;
  disconnect.hidden = !googleCalendar.connected;
}

function connectGoogleCalendar() {
  if (!currentUser || currentRole !== "general") return;
  window.location.href = API_BASE + "/auth/google?userId=" + encodeURIComponent(currentUser.id);
}

async function disconnectGoogleCalendar() {
  if (!currentUser) return;
  try {
    var response = await fetch(API_BASE + "/api/google-calendar/disconnect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not disconnect Google Calendar.");
    googleCalendar = result;
    renderGoogleCalendarStatus();
    toast("Google Calendar disconnected.");
  } catch (error) {
    toast(error.message);
  }
}

function logout() {
  clearInterval(workflowRefreshTimer);
  currentRole = null;
  currentUser = null;
  localStorage.removeItem("kareCurrentUser");
  localStorage.removeItem("kareCurrentRole");
  $("#screen-app").classList.remove("active");
  $("#screen-login").classList.add("active");
  $("#screen-login").style.background = "";
  $("#screen-login").style.backgroundImage = "";
  $("#screen-login").classList.remove("login-open", "calendar-open");
  $("#loginPage").classList.remove("login-open", "calendar-open");
    $("#loginFields").hidden = false;
  $("#loginForm").classList.remove("open");
  renderLoginEvents();
  window.scrollTo(0, 0);
  toast("Logged out successfully.");
}

async function restoreStoredLogin() {
  var storedUser = localStorage.getItem("kareCurrentUser");
  var storedRole = localStorage.getItem("kareCurrentRole");
  if (!storedUser || !storedRole || !ROLE_INFO[storedRole]) return;
  try {
    currentUser = JSON.parse(storedUser);
    currentRole = storedRole;
    loadRagHistory();
    await loadPublicPosts();
    if (storedRole === "general") {
      await loadRegistrations();
      await loadGoogleCalendarStatus();
    }
    if (["faculty", "coordinator", "admin"].includes(storedRole)) await loadWorkflowPosts();
    if (storedRole === "admin") await loadUsers();
    await loadAnalytics();
    await loadNotifications();
    $("#screen-login").classList.remove("active");
    $("#screen-app").classList.add("active");
    buildShell(storedRole);
    startLiveWorkflowRefresh();
  } catch (error) {
    localStorage.removeItem("kareCurrentUser");
    localStorage.removeItem("kareCurrentRole");
    currentUser = null;
    currentRole = null;
    console.warn("Saved login could not be restored.", error);
  }
}

/* ---------- shell / navigation ---------- */
var NAV = {
  faculty: [
    ["dashboard", "⌂", "Dashboard"], ["approvals", "✓", "Approvals"], ["calendar", "▣", "Calendar"],
    ["analytics", "▥", "Analytics"], ["notifications", "○", "Notifications"]
  ],
  coordinator: [
    ["dashboard", "⌂", "Dashboard"], ["create", "+", "Create Post"], ["myposts", "▣", "My Posts"],
    ["pending", "○", "Pending"], ["rejected", "×", "Rejected"], ["calendar", "▣", "Calendar"],
    ["templates", "▤", "Templates"], ["analytics", "▥", "Analytics"], ["notifications", "○", "Notifications"]
  ],
  admin: [
    ["dashboard", "⌂", "Dashboard"], ["users", "♙", "Users"],
    ["allposts", "▣", "All Posts"], ["calendar", "▣", "Calendar"],
    ["analytics", "▥", "Analytics"], ["notifications", "○", "Notifications"]
  ],
  general: [
    ["dashboard", "⌂", "Dashboard"], ["chat", "✦", "Chat Assistant"], ["registrations", "✓", "Registered Events"], ["calendar", "▣", "Calendar"], ["notifications", "○", "Notifications"]
  ]
};

function buildShell(role) {
  var info = ROLE_INFO[role];
  $("#whoName").textContent = info.label;
  $("#whoAvatar").textContent = info.initials;
  $("#roleTag").textContent = info.label + " Panel";

  var nav = $("#navList");
  nav.innerHTML = "";
  NAV[role].forEach(function (item, i) {
    var b = document.createElement("button");
    b.className = "nav-item" + (i === 0 ? " active" : "");
    b.innerHTML = "<span>" + item[1] + "</span><span>" + item[2] + "</span>";
    b.onclick = function () { go(item[0], b); };
    nav.appendChild(b);
  });

  $$(".role-page").forEach(function (p) { p.classList.remove("active"); });
  $$('[data-role]').forEach(function (el) { el.style.display = el.getAttribute("data-role") === role ? "" : "none"; });
  go("dashboard", $(".nav-item"));
}

function go(page, btn) {
  if (currentPage === "notifications" && page !== "notifications") markNotificationsReadOnServer();
  $$(".nav-item").forEach(function (b) { b.classList.remove("active"); });
  if (btn) btn.classList.add("active");
  $$(".role-page").forEach(function (p) { p.classList.remove("active"); });
  var target = $("#page-" + currentRole + "-" + page) || $("#page-shared-" + page);
  if (target) target.classList.add("active");
  if (["faculty", "coordinator", "admin"].includes(currentRole) && ["dashboard", "approvals", "pending", "myposts", "notifications"].includes(page)) {
    loadWorkflowPosts().then(render);
    loadNotifications();
  }
  render();
  buildCalendar();
  currentPage = page;
  window.scrollTo(0, 0);
}

function goTo(page) {
  var idx = NAV[currentRole].findIndex(function (n) { return n[0] === page; });
  go(page, $$(".nav-item")[idx]);
}

function startLiveWorkflowRefresh() {
  clearInterval(workflowRefreshTimer);
  if (!currentUser || !["faculty", "coordinator", "admin"].includes(currentRole)) return;
  workflowRefreshTimer = setInterval(function () {
    loadWorkflowPosts().then(render);
    loadNotifications();
  }, 15000);
}

function selectTemplate(name) {
  if (!currentRole) {
    toast("Please login before using a template.");
    return;
  }
  var preview = $("#selectedTemplate");
  if (preview) preview.textContent = "Template: " + name;
  goTo("create");
  toast("<b>" + esc(name) + "</b> selected for your new post.");
}

function templatePosterUrl(template) {
  return "images/templates/" + template.file;
}

function renderTemplates() {
  var gallery = $("#templateGallery");
  if (!gallery) return;
  gallery.innerHTML = TEMPLATE_POSTERS.map(function (template) {
    var url = templatePosterUrl(template);
    return '<article class="tpl poster-template">' +
      '<img class="template-thumb-image" src="' + url + '" alt="' + esc(template.name) + ' poster" />' +
      '<div class="body"><b>' + esc(template.name) + '</b><a class="btn btn-download btn-sm" href="' + url + '" download="' + esc(template.file) + '">DOWNLOAD</a></div>' +
    '</article>';
  }).join("");
}

function openTemplatePreview(name) {
  var template = TEMPLATE_POSTERS.find(function (item) { return item.name === name; });
  if (!template) return;
  var image = $("#templatePreviewImage");
  var fallback = $("#templatePreviewFallback");
  var download = $("#templateDownload");
  $("#templatePreviewTitle").textContent = template.name;
  image.hidden = false;
  fallback.hidden = true;
  image.src = templatePosterUrl(template);
  image.alt = template.name + " poster";
  image.onerror = function () { image.hidden = true; fallback.hidden = false; };
  download.href = templatePosterUrl(template);
  download.download = template.file;
  $("#templatePreviewModal").classList.add("open");
}

function closeTemplatePreview() { $("#templatePreviewModal").classList.remove("open"); }

/* ---------- rendering ---------- */
function render() {
  renderFaculty();
  renderCoordinator();
  renderAdmin();
  renderLoginEvents("#generalEvents");
  renderRegisteredEvents();
  renderAnalytics();
  renderNotifications();
  renderTemplates();
  renderRagChat();
}

async function loadNotifications() {
  notifications = [];
  notificationUserId = currentUser && currentUser.id ? String(currentUser.id) : null;
  if (!currentUser || !currentUser.id) {
    return;
  }
  try {
    var response = await fetch(API_BASE + "/api/notifications?userId=" + encodeURIComponent(currentUser.id));
    if (!response.ok) {
      return;
    }
    var rows = await response.json();
    var serverNotifications = (Array.isArray(rows) ? rows : []).map(function (row) {
      return {
        id: row.id,
        t: row.message || row.title || "Notification",
        s: row.created_at ? row.created_at : "Just now",
        read: !!row.read,
        type: row.type,
        forRoles: [String(currentRole || "").toLowerCase()]
      };
    });
    notifications = serverNotifications.concat(notifications.filter(function (n) { return !n.id || (n.id && !serverNotifications.some(function (serverItem) { return serverItem.id === n.id; })); }));
    notifications = notifications.slice(0, 30);
    renderNotifications();
    var latestUnread = notifications.find(function (notification) { return !notification.read && notification.id; });
    if (latestUnread && latestUnread.id !== lastNotificationToastId) {
      lastNotificationToastId = latestUnread.id;
      toast("<b>New notification</b><br>" + esc(latestUnread.t));
    }
  } catch (error) {
    console.warn("Notifications API unavailable; using local prototype notifications.", error);
  }
}

async function markNotificationsReadOnServer() {
  if (!currentUser || !currentUser.id || notificationUserId !== String(currentUser.id) || !notifications.length) return;
  var ids = notifications.filter(function (n) { return !n.read; }).map(function (n) { return n.id; });
  if (!ids.length) return;
  notifications = notifications.map(function (n) { n.read = true; return n; });
  renderNotifications();
  try {
    await fetch(API_BASE + "/api/notifications/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id, notificationIds: ids })
    });
  } catch (error) {
    console.warn("Could not mark notifications as read on the server.", error);
  }
}

async function clearNotifications() {
  if (!currentUser || !currentUser.id || notificationsClearInFlight) return;
  notificationsClearInFlight = true;
  var buttons = $$("[data-clear-notifications]");
  buttons.forEach(function (button) { button.disabled = true; });
  notifications = [];
  renderNotifications();
  try {
    var response = await fetch(API_BASE + "/api/notifications/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not clear notifications.");
    toast("Notifications cleared.");
  } catch (error) {
    toast(error.message || "Could not clear notifications.");
    await loadNotifications();
  } finally {
    notificationsClearInFlight = false;
    buttons.forEach(function (button) { button.disabled = false; });
  }
}

function renderNotifications() {
  if (!currentRole) return;
  var visible = notifications.filter(function (n) {
    if (n.forRoles && n.forRoles.indexOf(currentRole) === -1) return false;
    return true;
  });
  var html = visible.map(function (n) {
    return '<li class="' + (n.read ? 'notification-read' : 'notification-unread') + '"><span class="dot"></span><div>' + esc(n.t) + '<small>' + esc(n.s) + '</small></div></li>';
  }).join("") || '<li><div>No new notifications.</div></li>';
  ["#notificationsList", "#notificationsListShared"].forEach(function (selector) {
    var list = $(selector);
    if (list) list.innerHTML = html;
  });
}

async function loadPublicPosts() {
  try {
    var response = await fetch(API_BASE + "/api/posts?userId=" + encodeURIComponent(currentUser && currentUser.id || ""));
    if (!response.ok) return;
    var remotePosts = await response.json();
    if (!Array.isArray(remotePosts)) return;
    posts = remotePosts.map(function (p) {
      return { id: p.id, createdBy: p.created_by, title: p.title, type: p.type, author: p.author, date: p.date, time: p.time,
        venue: p.venue, status: p.status === "published" ? "scheduled" : p.status,
        caption: p.caption || "—", desc: p.description || "—", posterUrl: p.poster_url || "", approvalDecision: p.approval_decision || "",
        likesCount: Number(p.likes_count || 0), liked: !!p.liked };
    });
  } catch (error) {
    posts = [];
    console.warn("Posts API unavailable; showing the database empty state.", error);
  }
}

async function loadRegistrations() {
  registrations = [];
  if (!currentUser || !currentUser.id) return;
  try {
    var response = await fetch(API_BASE + "/api/registrations?userId=" + encodeURIComponent(currentUser.id));
    if (!response.ok) return;
    var rows = await response.json();
    registrations = Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn("Registrations API unavailable.", error);
  }
}

async function loadWorkflowPosts() {
  try {
    var response = await fetch(API_BASE + "/api/posts?workflow=1&userId=" + encodeURIComponent(currentUser && currentUser.id || ""));
    if (!response.ok) {
      var errorBody = await response.json().catch(function () { return {}; });
      throw new Error(errorBody.error || "Workflow posts could not be loaded.");
    }
    var remotePosts = await response.json();
    if (!Array.isArray(remotePosts)) return;
    posts = remotePosts.map(function (p) {
      return { id: p.id, createdBy: p.created_by, title: p.title, type: p.type, author: p.author, date: p.date, time: p.time,
        venue: p.venue, status: p.status, caption: p.caption || "—", desc: p.description || "—",
        reason: p.rejection_reason || "", posterUrl: p.poster_url || "", approvalDecision: p.approval_decision || "",
        likesCount: Number(p.likes_count || 0), liked: !!p.liked };
    });
  } catch (error) {
    posts = [];
    toast(error.message);
    console.error("Workflow API unavailable.", error);
  }
}

async function loadUsers() {
  try {
    var response = await fetch(API_BASE + "/api/users");
    if (!response.ok) return;
    var rows = await response.json();
    users = Array.isArray(rows) ? rows.map(function (user) {
      return { id: user.id, name: user.name, email: user.email, role: user.role, dept: user.department || "", status: user.status === "active" ? "Active" : user.status };
    }) : [];
  } catch (error) {
    users = [];
    console.warn("Users API unavailable; showing the database empty state.", error);
  }
}

async function loadAnalytics() {
  try {
    var response = await fetch(API_BASE + "/api/analytics?userId=" + encodeURIComponent(currentUser && currentUser.id || ""));
    if (!response.ok) return;
    var result = await response.json();
    analyticsData = result && result.summary ? result : analyticsData;
  } catch (error) {
    analyticsData = { summary: { total_likes: 0, general_users: 0, published_posts: 0 }, posts: [] };
    console.warn("Analytics API unavailable; showing zero database metrics.", error);
  }
}

function renderFaculty() {
  $("#fStatPending").textContent = String(countBy("pending")).padStart(2, "0");
  $("#fStatApproved").textContent = String(countBy("approved") + countBy("scheduled")).padStart(2, "0");
  $("#fStatRejected").textContent = String(countBy("rejected")).padStart(2, "0");

  var pend = posts.filter(function (p) { return p.status === "pending"; });
  var html = pend.map(function (p) {
    return '<div class="post-item"><div><div class="pi-title">' + esc(p.title) + "</div>" +
      '<div class="pi-meta">Submitted by: ' + esc(p.author) + " · Event: " + esc(p.date) + " · " + esc(p.venue) + "</div></div>" +
      '<div class="pi-actions">' + badge(p.status) + '<button class="btn btn-primary btn-sm" onclick="openReview(' + p.id + ')">REVIEW</button></div></div>';
  }).join("");
  var pendHtml = html || '<div class="empty">No pending approvals. All caught up!</div>';
  $("#fPendingList").innerHTML = pendHtml;
  $("#fPendingList2").innerHTML = pendHtml;
  $("#fApprovalsNote").style.display = pend.length ? "none" : "";

  var done = posts.filter(function (p) { return p.approvalDecision === "approved" || p.approvalDecision === "rejected" || p.status === "approved" || p.status === "rejected" || p.status === "scheduled"; });
  var hist = done.map(function (p) {
    var decision = p.approvalDecision || (p.status === "scheduled" ? "approved" : p.status);
    return "<tr><td><b>" + esc(p.title) + "</b></td><td>" + esc(p.author) + "</td><td>" + esc(p.date) + "</td><td>" + badge(decision) + "</td></tr>";
  }).join("");
  $("#fHistory").innerHTML = hist;
  $("#fHistory2").innerHTML = hist;
}

function renderCoordinator() {
  $("#cStatDrafts").textContent = String(countBy("draft")).padStart(2, "0");
  $("#cStatPending").textContent = String(countBy("pending")).padStart(2, "0");
  $("#cStatApproved").textContent = String(countBy("approved") + countBy("scheduled")).padStart(2, "0");
  $("#cStatLikes").textContent = String(Number((analyticsData.summary || {}).total_likes || 0));

  var mine = posts.filter(function (p) {
    return (p.createdBy && currentUser && String(p.createdBy) === String(currentUser.id)) ||
      (currentUser && p.author === currentUser.name);
  });
  var approvedMine = mine.filter(function (p) { return p.status === "approved"; });
  $("#cRecent").innerHTML = mine.slice(0, 5).map(function (p) {
    return '<div class="post-item"><div><div class="pi-title">' + esc(p.title) + "</div>" +
      '<div class="pi-meta">' + esc(p.type) + " · " + esc(p.date) + " · " + esc(p.venue) + "</div></div>" + badge(p.status) + "</div>";
  }).join("");

  $("#cMyPosts").innerHTML = approvedMine.map(function (p) {
    var action = '<button class="btn btn-primary btn-sm" onclick="goTo(\'calendar\')">VIEW CALENDAR</button>';
    return "<tr><td><b>" + esc(p.title) + "</b></td><td>" + esc(p.type) + "</td><td>" + esc(p.date) + "</td><td>" + badge(p.status) + "</td><td>" + action + "</td></tr>";
  }).join("") || '<tr><td colspan="5" class="empty">No approved posts yet.</td></tr>';

  var pen = mine.filter(function (p) { return p.status === "pending"; });
  $("#cPending").innerHTML = pen.map(function (p) {
    return '<div class="post-item"><div><div class="pi-title">' + esc(p.title) + '</div><div class="pi-meta">Waiting for faculty approval · submitted ' + esc(p.date) + "</div></div>" + badge("pending") + "</div>";
  }).join("") || '<div class="empty">No posts awaiting approval.</div>';

  var rej = posts.filter(function (p) { return p.status === "rejected"; });
  $("#cRejected").innerHTML = rej.map(function (p) {
    return '<div class="post-item"><div><div class="pi-title">' + esc(p.title) + '</div><div class="pi-meta">Reason: ' + esc(p.reason || "Not specified") + "</div></div>" +
      '<div class="pi-actions">' + badge("rejected") + '<button class="btn btn-primary btn-sm" onclick="editPost(' + p.id + ')">EDIT</button></div></div>';
  }).join("") || '<div class="empty">No rejected posts.</div>';

}

function renderAdmin() {
  $("#aStatUsers").textContent = users.length;
  $("#aStatPosts").textContent = posts.length;
  $("#aStatPending").textContent = countBy("pending");
  $("#aStatScheduled").textContent = countBy("scheduled");

  $("#aActivity").innerHTML = activity.map(function (a) {
    return '<li><span class="dot"></span><div>' + esc(a.t) + "<small>" + esc(a.s) + "</small></div></li>";
  }).join("");

  renderUsers();
  renderAllPosts();
}

function renderUsers() {
  var q = ($("#userSearch") ? $("#userSearch").value : "").toLowerCase();
  var rows = users.filter(function (u) { return u.name.toLowerCase().indexOf(q) > -1 || u.role.toLowerCase().indexOf(q) > -1; });
  rows = rows.filter(function (u) { return u.role === "Faculty" || u.role === "Student Coordinator"; });
  $("#aUsers").innerHTML = rows.map(function (u) {
    return "<tr><td><b>" + esc(u.name) + "</b><div class='pi-meta'>" + esc(u.email) + "</div></td><td>" + esc(u.role) + "</td><td>" + esc(u.dept) + "</td>" +
      "<td>" + (u.status === "Active" ? '<span class="badge active">🟢 Active</span>' : '<span class="badge draft">⚪ Inactive</span>') + "</td>" +
      '<td><button class="btn btn-danger btn-sm" type="button" onclick="deleteUser(' + Number(u.id) + ')">DELETE</button></td></tr>';
  }).join("") || '<tr><td colspan="5" class="empty">No users found.</td></tr>';
}

async function deleteUser(userId) {
  var user = users.find(function (item) { return String(item.id) === String(userId); });
  if (!user || !window.confirm('Delete user "' + user.name + '"? This cannot be undone.')) return;
  try {
    var response = await fetch(API_BASE + "/api/users/" + encodeURIComponent(userId), {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminUserId: currentUser && currentUser.id })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "User could not be deleted.");
    users = users.filter(function (item) { return String(item.id) !== String(userId); });
    render();
    toast("User <b>" + esc(user.name) + "</b> deleted successfully.");
  } catch (error) {
    toast(error.message);
  }
}

function renderAllPosts() {
  var q = ($("#postSearch") ? $("#postSearch").value : "").toLowerCase();
  var f = $("#postFilter") ? $("#postFilter").value : "all";
  var rows = posts.filter(function (p) {
    return (f === "all" || p.status === f) && (p.title.toLowerCase().indexOf(q) > -1 || p.author.toLowerCase().indexOf(q) > -1);
  });
  $("#aPosts").innerHTML = rows.map(function (p) {
    return "<tr><td><b>" + esc(p.title) + "</b><div class='pi-meta'>" + esc(p.type) + " · " + esc(p.venue) + "</div></td><td>" + esc(p.author) +
      "</td><td>" + esc(p.date) + "</td><td>" + badge(p.status) + "</td></tr>";
  }).join("") || '<tr><td colspan="4" class="empty">No posts match the filter.</td></tr>';
}

/* ---------- review modal (faculty) ---------- */
function openReview(id) {
  reviewId = id;
  var p = posts.find(function (x) { return x.id === id; });
  $("#rvTitle").textContent = p.title.toUpperCase();
  var reviewPoster = p.posterUrl ? '<img class="review-poster-image" src="' + esc(p.posterUrl) + '" alt="Poster for ' + esc(p.title) + '" />' : "";
  $("#rvBody").innerHTML =
    reviewPoster +
    '<div class="kv" style="margin-top:16px"><span>Submitted by</span><div>' + esc(p.author) + "</div>" +
    "<span>Post type</span><div>" + esc(p.type) + "</div>" +
    "<span>Date</span><div>" + esc(p.date) + "</div>" +
    "<span>Time</span><div>" + esc(p.time) + "</div>" +
    "<span>Venue</span><div>" + esc(p.venue) + "</div></div>" +
    "<b style='font-size:13px'>Description</b><p style='margin:6px 0 14px;font-size:14px;line-height:1.6'>" + esc(p.desc) + "</p>" +
    "<b style='font-size:13px'>Caption</b><p style='margin:6px 0 0;font-size:14px;line-height:1.6'>" + esc(p.caption) + "</p>";
  $("#reviewModal").classList.add("open");
}
function closeReview() { $("#reviewModal").classList.remove("open"); }

async function decide(status) {
  if (decisionInFlight) return;
  decisionInFlight = true;
  var p = posts.find(function (x) { return x.id === reviewId; });
  if (!p) {
    decisionInFlight = false;
    return;
  }
  p.status = status;
  p.approvalDecision = status;
  if (status === "rejected") p.reason = "Needs revision as per faculty review.";
  closeReview();
  render();
  try {
    var response = await fetch(API_BASE + "/api/posts/" + encodeURIComponent(p.id) + "/decision", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: status, reviewerId: currentUser && currentUser.id, reason: p.reason || "" })
    });
    var result = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(result.error || "Decision was not saved to the server.");
    await loadWorkflowPosts();
    await loadNotifications();
  } catch (error) {
    console.warn(error);
    toast(error.message);
    decisionInFlight = false;
    return;
  }
  decisionInFlight = false;
  toast(status === "approved"
    ? "<b>" + esc(p.title) + "</b> approved and added to the calendar."
    : "<b>" + esc(p.title) + "</b> rejected. Coordinator notified.");
}

/* ---------- create post (coordinator) ---------- */
var editingPostId = null;
function editPost(id) {
  var p = posts.find(function (item) { return item.id === id; });
  if (!p) return;
  editingPostId = id;
  $("#npTitle").value = p.title;
  $("#npType").value = p.type;
  $("#npVenue").value = p.venue;
  $("#npTime").value = p.time;
  $("#npDesc").value = p.desc || "";
  $("#npCaption").value = p.caption || "";
  $("#selectedTemplate").textContent = "Editing rejected post";
  goTo("create");
}

async function schedulePost(id) {
  var p = posts.find(function (item) { return item.id === id; });
  if (!p) return;
  if (p.status !== "approved") p.status = "approved";
  if (!p.posterUrl) p.posterUrl = "";
  p.status = "scheduled";
  render();
  buildCalendar();
  toast("<b>" + esc(p.title) + "</b> added to the calendar.");
}

async function submitPost(e, mode) {
  if (e) e.preventDefault();
  if (submitInFlight) return false;
  submitInFlight = true;
  var title = $("#npTitle").value.trim();
  if (!title) { submitInFlight = false; toast("Please enter an event title."); return false; }
  var d = $("#npDate").value;
  var pretty = d ? new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "TBD";
  var post = {
    id: editingPostId || Date.now(), title: title, type: $("#npType").value, author: currentUser ? currentUser.name : "Bala",
    date: pretty, time: $("#npTime").value || "10:00 AM", venue: $("#npVenue").value || "Seminar Hall",
    status: mode === "draft" ? "draft" : "pending",
    desc: $("#npDesc").value || "—", caption: $("#npCaption").value || "—"
  };
  var existingPost = editingPostId && posts.find(function (item) { return item.id === editingPostId; });
  post.posterUrl = existingPost ? existingPost.posterUrl || "" : "";
  var posterFile = $("#npFile").files[0];
  if (posterFile) {
    post.posterUrl = await new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { resolve(""); };
      reader.readAsDataURL(posterFile);
    });
  }
  try {
    var response = await fetch(API_BASE + (editingPostId ? "/api/posts/" + encodeURIComponent(editingPostId) : "/api/posts"), {
      method: editingPostId ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: currentUser && currentUser.id, title: title, type: post.type, date: d,
        time: $("#npTime").value || "10:00:00", venue: post.venue, description: post.desc, caption: post.caption, posterData: post.posterUrl || "",
        status: mode === "draft" ? "draft" : "pending" })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Post could not be saved.");
    post.id = Number(result.id || post.id);
  } catch (error) {
    console.warn(error);
    toast(error.message);
    submitInFlight = false;
    return false;
  }
  editingPostId = null;
  await loadWorkflowPosts();
  await loadNotifications();
  $("#createForm").reset();
  render();
  submitInFlight = false;
  if (mode === "draft") {
    toast("Saved as draft.");
    goTo("myposts");
  } else {
    $("#successModal").classList.add("open");
  }
  return false;
}

async function checkSimilarity() {
  if (similarityInFlight) return;
  var title = $("#npTitle").value.trim();
  if (!title) { toast("Please enter an event title first."); return; }
  similarityInFlight = true;
  var button = $("#checkSimilarityButton");
  var resultPanel = $("#similarityResult");
  button.disabled = true;
  button.querySelector(".ai-button-label").textContent = "Checking...";
  resultPanel.hidden = false;
  resultPanel.className = "similarity-result loading";
  resultPanel.textContent = "Comparing this event with previous submissions...";
  try {
    var response = await fetch(API_BASE + "/api/similarity/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title,
        type: $("#npType").value,
        description: $("#npDesc").value,
        date: $("#npDate").value,
        time: $("#npTime").value,
        venue: $("#npVenue").value
      })
    });
    var data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "AI similarity check failed.");
    }
    var topMatch = data.matches && data.matches[0];
    if (!topMatch) {
      resultPanel.className = "similarity-result clear";
      resultPanel.innerHTML = "<strong>AI similarity check complete</strong><span>No similar previous event was found.</span>";
    } else {
      var percentage = Math.round(topMatch.similarity * 100);
      resultPanel.className = "similarity-result " + (data.duplicateDetected ? "warning" : "possible");
      resultPanel.innerHTML = "<strong>" + (data.duplicateDetected ? "Highly similar event detected" : "Possibly similar event detected") + "</strong>" +
        "<span>Similarity: " + percentage + "% · Existing event: <b>" + esc(topMatch.title) + "</b></span>" +
        "<span>The coordinator can still submit this post for faculty approval.</span>";
    }
  } catch (error) {
    resultPanel.className = "similarity-result error";
    resultPanel.textContent = error.message === "Failed to fetch"
      ? "The API server is unavailable. Start the application and try again."
      : error.message;
  } finally {
    similarityInFlight = false;
    button.disabled = false;
    button.querySelector(".ai-button-label").textContent = "Check similarity";
  }
}

async function generateAICaption() {
  if (captionInFlight) return;
  var title = $("#npTitle").value.trim();
  if (!title) { toast("Please enter an event title first."); return; }
  if ($("#npCaption").value.trim() && !window.confirm("Replace the existing caption with a generated caption?")) return;
  captionInFlight = true;
  var button = $("#generateCaptionButton");
  var result = $("#captionResult");
  button.disabled = true;
  button.querySelector(".ai-button-label").textContent = "Generating...";
  result.hidden = false;
  result.className = "caption-result loading";
  result.textContent = "Generating AI caption locally...";
  try {
    var response = await fetch(API_BASE + "/api/ai/generate-caption", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: title,
        description: $("#npDesc").value,
        category: $("#npType").value,
        date: $("#npDate").value,
        time: $("#npTime").value,
        venue: $("#npVenue").value
      })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI caption generation failed.");
    $("#npCaption").value = data.caption;
    result.className = "caption-result success";
    result.textContent = "AI caption generated. You can edit it before submitting.";
  } catch (error) {
    result.className = "caption-result error";
    var message = error.message === "Failed to fetch"
      ? "The API server is unavailable. Start the application and try again."
      : error.message;
    result.textContent = message + " You can enter the caption manually.";
  } finally {
    captionInFlight = false;
    button.disabled = false;
    button.querySelector(".ai-button-label").textContent = "Generate";
  }
}

async function generateAIDescription() {
  if (descriptionInFlight) return;
  var title = $("#npTitle").value.trim();
  if (!title) { toast("Please enter an event title first."); return; }
  if ($("#npDesc").value.trim() && !window.confirm("Replace the existing description with a generated description?")) return;
  descriptionInFlight = true;
  var button = $("#generateDescriptionButton");
  var result = $("#descriptionResult");
  button.disabled = true;
  button.querySelector(".ai-button-label").textContent = "Generating...";
  result.hidden = false;
  result.className = "caption-result loading";
  result.textContent = "Generating AI description locally...";
  try {
    var response = await fetch(API_BASE + "/api/ai/generate-description", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title, category: $("#npType").value, date: $("#npDate").value, time: $("#npTime").value, venue: $("#npVenue").value })
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || "AI description generation failed.");
    $("#npDesc").value = data.description;
    result.className = "caption-result success";
    result.textContent = "AI description generated. You can edit it before submitting.";
  } catch (error) {
    result.className = "caption-result error";
    var message = error.message === "Failed to fetch"
      ? "The API server is unavailable. Start the application and try again."
      : error.message;
    result.textContent = message + " You can enter the description manually.";
  } finally {
    descriptionInFlight = false;
    button.disabled = false;
    button.querySelector(".ai-button-label").textContent = "Generate";
  }
}
function closeSuccess() { $("#successModal").classList.remove("open"); goTo("pending"); }

/* ---------- add user (admin) ---------- */
function openAddUser() { $("#userModal").classList.add("open"); }
function closeAddUser() { $("#userModal").classList.remove("open"); }
async function createUser(e) {
  if (e) e.preventDefault();
  var name = $("#auName").value.trim();
  if (!name) { toast("Please enter a name."); return false; }
  var email = $("#auEmail").value.trim().toLowerCase();
  var password = $("#auPass").value;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 6) {
    toast("Enter a valid email and a password of at least 6 characters.");
    return false;
  }
  try {
    var response = await fetch(API_BASE + "/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name, email: email, password: password, role: $("#auRole").value, department: $("#auDept").value })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "User creation failed.");
  } catch (error) {
    toast(error.message);
    return false;
  }
  users.unshift({ name: name, email: email, role: $("#auRole").value, dept: $("#auDept").value, status: "Active" });
  activity.unshift({ t: "New user \"" + name + "\" added by Admin", s: "Just now" });
  $("#userForm").reset();
  closeAddUser();
  render();
  toast("User <b>" + esc(name) + "</b> created successfully.");
  return false;
}

/* ---------- upcoming events (login screen) ---------- */
var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function postDate(p) {
  var m = /^(\d{2}) (\w{3}) (\d{4})$/.exec(p.date);
  if (!m) return null;
  var mi = MONTHS.indexOf(m[2]);
  if (mi < 0) return null;
  return new Date(parseInt(m[3], 10), mi, parseInt(m[1], 10));
}

function posterClass(type) {
  return String(type).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function renderLoginEvents(target) {
  var wrap = $(target || "#loginEvents");
  if (!wrap) return;
  var list = posts.filter(function (p) {
    return isCalendarEvent(p);
  });
  list.sort(function (a, b) { return postDate(a) - postDate(b); });
  list = list.slice(0, 6);
  wrap.innerHTML = list.map(function (p) {
    var d = postDate(p);
    var liked = hasUserLikedPost(p.id);
    var likeCount = getLikeCount(p.id);
    return '<article id="event-' + esc(p.id) + '" class="event-poster poster-' + posterClass(p.type) + '" style="border: 0; border-radius: 0; box-shadow: none; background: #ffffff; min-height: 205px;">' +
      '<div class="poster-top" style="padding: 11px 14px; background: #3f91bd; color: #ffffff; font-size: 11px; border-bottom: 0;"><span>' + esc(p.type) + '</span><span>Department Event</span></div>' +
      (p.posterUrl ? '<a class="event-poster-link" href="' + esc(p.posterUrl) + '" target="_blank" rel="noopener" download="' + esc(p.title) + '"><img class="event-poster-image" src="' + esc(p.posterUrl) + '" alt="Open full poster for ' + esc(p.title) + '" /></a>' : '') +
      '<div class="poster-content" style="padding: 18px 16px; color: var(--ink); align-items: center; display: flex; gap: 16px;">' +
      '<div class="poster-date" style="border: 0; border-right: 1px solid #d9e2ea; color: #287ca9; padding-right: 15px; text-align: center; flex: 0 0 58px;">' +
      '<b style="display:block;font-size:34px;line-height:1;">' + String(d.getDate()).padStart(2, "0") +
      '</b><small style="font-size:13px;text-transform:uppercase;">' + MONTHS[d.getMonth()] + '</small></div><div><h4 style="margin:0 0 7px; color:#1d4260; font-size:20px;">' + esc(p.title) + '</h4><p style="margin:0; color:#637487; font-size:13px;">' +
      esc(p.time) + " | " + esc(p.venue) + '</p></div></div>' +
      '<div class="poster-footer" style="padding: 9px 14px; border-top: 1px solid #d9e2ea; color: #3f91bd; font-size: 10px; letter-spacing: 1px; display:flex; justify-content:space-between; align-items:center;">' +
      '<span>KARE CSE</span>' +
      (target === "#generalEvents" ? '<span style="display:flex;gap:8px;align-items:center"><button type="button" class="like-btn' + (liked ? ' liked' : '') + '" data-like-id="' + p.id + '">♥ <span>' + likeCount + '</span></button><button type="button" class="btn btn-primary btn-sm register-event-btn" data-register-id="' + p.id + '">REGISTER</button></span>' : '') +
      '</div></article>';
  }).join("") || '<div class="empty">No upcoming events.</div>';
  $$(".like-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      toggleLike(Number(button.getAttribute("data-like-id")));
    });
  });
  $$(".register-event-btn").forEach(function (button) {
    button.addEventListener("click", function () {
      openEventRegistration(Number(button.getAttribute("data-register-id")));
    });
  });
}

function renderRegisteredEvents() {
  var wrap = $("#registeredEvents");
  if (!wrap) return;
  wrap.innerHTML = registrations.map(function (p) {
    return '<article class="event-poster" style="background:#fff;min-height:180px">' +
      (p.posterUrl ? '<img class="event-poster-image" src="' + esc(p.posterUrl) + '" alt="Poster for ' + esc(p.title) + '" />' : '') +
      '<div class="poster-content" style="padding:16px"><h4 style="margin:0 0 7px;color:#1d4260;font-size:18px">' + esc(p.title) + '</h4><p style="margin:0;color:#637487;font-size:13px">' + esc(p.date || "Date pending") + ' | ' + esc(p.time || "Time pending") + '</p><p style="margin:6px 0 0;color:#637487;font-size:13px">' + esc(p.venue || "Venue pending") + '</p></div>' +
      '<div class="poster-footer" style="padding:9px 14px;border-top:1px solid #d9e2ea;color:#287ca9;font-size:11px"><span>REGISTRATION CONFIRMED</span></div></article>';
  }).join("") || '<div class="empty">You have not registered for any events yet.</div>';
}

function openEventRegistration(postId) {
  if (!currentUser || currentRole !== "general") {
    toast("Login as General User to register for an event.");
    return;
  }
  scannerPost = posts.find(function (item) { return String(item.id) === String(postId); });
  if (!scannerPost) return;
  $("#eventRegistrationTitle").textContent = "REGISTER FOR " + String(scannerPost.title).toUpperCase();
  $("#scannerPoster").src = scannerPost.posterUrl || "";
  $("#scannerPoster").hidden = !scannerPost.posterUrl;
  $("#scannerFile").value = "";
  $("#scannerScanButton").hidden = false;
  $("#openRegistrationFormButton").hidden = true;
  $("#registrationCompleteButton").hidden = true;
  $("#scannerStatus").textContent = scannerPost.posterUrl ? "Ready to scan the QR code in this poster." : "This event has no poster to scan.";
  $("#eventRegistrationModal").classList.add("open");
}

function closeEventRegistration() {
  scannerPost = null;
  $("#eventRegistrationModal").classList.remove("open");
}

function isRegistrationQr(value) {
  var text = String(value || "").trim().toLowerCase();
  if (!/^https?:\/\//.test(text)) return false;
  if (/(wa\.me|whatsapp|chat\.whatsapp|telegram|discord|instagram|facebook|linkedin|t\.me)/.test(text)) return false;
  return /(register|registration|signup|sign-up|form|forms\.gle|google\.com\/forms|forms\.office\.com)/.test(text) || !/(join|group|community|channel|follow|social)/.test(text);
}

function scanPosterForQrs(image) {
  var maxDimension = 1800;
  var scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  var width = Math.max(1, Math.round(image.naturalWidth * scale));
  var height = Math.max(1, Math.round(image.naturalHeight * scale));
  var canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  var context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  var candidates = [];
  var regions = [{ x: 0, y: 0, width: width, height: height }];
  var columns = 3;
  var overlap = 0.2;
  for (var row = 0; row < columns; row += 1) {
    for (var column = 0; column < columns; column += 1) {
      var cellWidth = Math.ceil(width / columns);
      var cellHeight = Math.ceil(height / columns);
      var x = Math.max(0, Math.floor(column * cellWidth - cellWidth * overlap));
      var y = Math.max(0, Math.floor(row * cellHeight - cellHeight * overlap));
      var right = Math.min(width, Math.ceil((column + 1) * cellWidth + cellWidth * overlap));
      var bottom = Math.min(height, Math.ceil((row + 1) * cellHeight + cellHeight * overlap));
      regions.push({ x: x, y: y, width: right - x, height: bottom - y });
    }
  }
  regions.forEach(function (region) {
    var code = window.jsQR(context.getImageData(region.x, region.y, region.width, region.height).data, region.width, region.height, { inversionAttempts: "attemptBoth" });
    if (code && code.data && candidates.indexOf(code.data) === -1) candidates.push(code.data);
  });
  return candidates;
}

async function scanEventPoster() {
  if (!scannerPost) return;
  var file = $("#scannerFile").files[0];
  var image = $("#scannerPoster");
  if (file) image.src = URL.createObjectURL(file);
  if (!image.src) {
    $("#scannerStatus").textContent = "Select the event poster image first.";
    return;
  }
  if (typeof window.jsQR !== "function") {
    $("#scannerStatus").textContent = "The QR detector could not be loaded. Check your internet connection and reload the page.";
    return;
  }
  $("#scannerStatus").textContent = "Scanning poster...";
  try {
    if (image.decode) await image.decode();
    var candidates = scanPosterForQrs(image);
    var registrationCodes = candidates.filter(isRegistrationQr);
    if (!registrationCodes.length) {
      if (candidates.length) throw new Error("QR codes were found, but they are WhatsApp or social-group links. No registration link was detected.");
      throw new Error("No QR code was found in this poster.");
    }
    var registrationUrl = registrationCodes[0];
    scannerPost.registrationUrl = registrationUrl;
    $("#scannerStatus").innerHTML = "Registration form found. Open it, complete the form, then confirm here.";
    $("#scannerScanButton").hidden = true;
    $("#openRegistrationFormButton").hidden = false;
    $("#registrationCompleteButton").hidden = false;
  } catch (error) {
    $("#scannerStatus").textContent = error.message;
  }
}

function openRegistrationForm() {
  if (scannerPost && scannerPost.registrationUrl) window.open(scannerPost.registrationUrl, "_blank", "noopener,noreferrer");
}

async function completeEventRegistration() {
  if (!scannerPost || !scannerPost.registrationUrl) return;
  try {
    var response = await fetch(API_BASE + "/api/posts/" + encodeURIComponent(scannerPost.id) + "/registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Registration could not be saved.");
    var registeredTitle = scannerPost.title;
    await loadRegistrations();
    render();
    closeEventRegistration();
    var calendarMessage = result.calendar && result.calendar.status === "synced"
      ? " Added to your Google Calendar with a 1-day reminder."
      : result.calendar && result.calendar.status === "failed"
        ? " Registration saved, but Google Calendar sync failed."
        : " Connect Google Calendar from your dashboard to add it automatically.";
    toast("Registration completed for <b>" + esc(registeredTitle) + "</b>." + calendarMessage);
  } catch (error) {
    $("#scannerStatus").textContent = error.message;
  }
}

async function toggleLike(postId) {
  if (!currentUser || currentRole !== "general") {
    toast("Login as General User to like an event.");
    return;
  }
  var post = posts.find(function (item) { return String(item.id) === String(postId); });
  if (!post) return;
  try {
    var response = await fetch(API_BASE + "/api/posts/" + encodeURIComponent(postId) + "/like", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: currentUser.id, liked: !post.liked })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "Like could not be saved.");
    post.liked = result.liked;
    post.likesCount = Number(result.likes || 0);
  } catch (error) {
    toast(error.message);
    return;
  }
  renderLoginEvents("#generalEvents");
  await loadAnalytics();
  renderAnalytics();
}

function ragHistoryKey() { return "kareRagHistory:" + String(currentUser && currentUser.id || "guest"); }

function loadRagHistory() {
  try {
    var stored = JSON.parse(localStorage.getItem(ragHistoryKey()) || "[]");
    ragChatHistory = Array.isArray(stored) ? stored.slice(-30) : [];
  } catch (error) { ragChatHistory = []; }
}

function saveRagHistory() { localStorage.setItem(ragHistoryKey(), JSON.stringify(ragChatHistory.slice(-30))); }

function addRagMessage(role, text) {
  ragChatHistory.push({ role: role, text: text, createdAt: new Date().toISOString() });
  saveRagHistory();
  renderRagChat();
}

function renderRagChat() {
  var container = document.getElementById("ragChatMessages");
  var historyList = document.getElementById("ragHistoryList");
  var count = document.getElementById("ragHistoryCount");
  if (!container) return;
  var messages = ragChatHistory.length ? ragChatHistory : [{ role: "bot", text: "Ask about upcoming events, hackathons, workshops, or your registered events." }];
  container.innerHTML = messages.map(function (message) {
    return '<div class="rag-chat-message ' + esc(message.role) + '">' + esc(message.text) + '</div>';
  }).join("");
  container.scrollTop = container.scrollHeight;
  if (historyList) {
    var turns = ragChatHistory.filter(function (message) { return message.role === "user"; });
    historyList.innerHTML = turns.slice().reverse().map(function (turn) {
      return '<div class="rag-history-item"><span>' + esc(turn.text) + '</span><small>' + new Date(turn.createdAt).toLocaleString() + '</small></div>';
    }).join("") || '<p class="empty">Your questions will appear here.</p>';
    if (count) count.textContent = turns.length + (turns.length === 1 ? " chat" : " chats");
  }
}

function clearRagHistory() { ragChatHistory = []; saveRagHistory(); renderRagChat(); }

async function askRagAssistant(event) {
  if (event) event.preventDefault();
  var input = document.getElementById("ragChatInput");
  var submit = document.getElementById("ragChatSubmit");
  var question = input ? input.value.trim() : "";
  if (!question || ragChatInFlight) return;
  ragChatInFlight = true;
  if (submit) {
    submit.disabled = true;
    submit.textContent = "Asking...";
  }
  addRagMessage("user", question);
  if (input) input.value = "";
  try {
    var response = await fetch(API_BASE + "/api/rag/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: question, userId: currentUser && currentUser.id })
    });
    var result = await response.json();
    if (!response.ok) throw new Error(result.error || "The department assistant could not answer the question.");
    addRagMessage("bot", result.answer || "I couldn't find this information in the department's available approved records.");
  } catch (error) {
    addRagMessage("bot", error.message || "The assistant is temporarily unavailable.");
  } finally {
    ragChatInFlight = false;
    if (submit) {
      submit.disabled = false;
      submit.textContent = "Ask";
    }
    if (input) input.focus();
  }
}

function attachRagChatHandlers() {
  var form = document.getElementById("ragChatForm");
  if (form) {
    form.addEventListener("submit", askRagAssistant);
  }
  var clearButton = document.getElementById("ragClearHistory");
  if (clearButton) clearButton.addEventListener("click", clearRagHistory);
  $$("[data-clear-notifications]").forEach(function (button) {
    button.addEventListener("click", clearNotifications);
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", function () {
    attachRagChatHandlers();
  });
}

function renderAnalytics() {
  var publicPosts = (analyticsData.posts || []).slice().sort(function (a, b) { return Number(b.likes || 0) - Number(a.likes || 0); });
  var summary = analyticsData.summary || {};
  var totalLikes = Number(summary.total_likes || 0);
  var generalUsersCount = Math.max(Number(summary.general_users || 0), 1);
  var publishedCount = Number(summary.published_posts || 0);
  var followers = generalUsersCount === 1 && !Number(summary.general_users) ? 0 : Number(summary.general_users || 0);
  var possibleLikes = publishedCount * followers;
  var engagementRate = possibleLikes ? ((totalLikes / possibleLikes) * 100).toFixed(1) : "0.0";
  var totalReach = totalLikes;

  if (document.getElementById("analyticsReach")) document.getElementById("analyticsReach").textContent = totalReach.toLocaleString();
  if (document.getElementById("analyticsEngagement")) document.getElementById("analyticsEngagement").textContent = engagementRate + "%";
  if (document.getElementById("analyticsPublished")) document.getElementById("analyticsPublished").textContent = String(publishedCount);
  if (document.getElementById("analyticsFollowers")) document.getElementById("analyticsFollowers").textContent = followers.toLocaleString();

  var platformWrap = document.getElementById("analyticsPlatforms");
  if (platformWrap) {
    platformWrap.innerHTML = [
      { label: "Total likes", value: totalLikes }
    ].map(function (p) {
      var pct = totalLikes ? (Math.min(100, (p.value / Math.max(totalLikes, 1)) * 100)).toFixed(1) : "0.0";
      return '<div class="bar-row"><div class="bl"><span>' + esc(p.label) + '</span><span>' + p.value + '</span></div><div class="bar"><span style="width:' + pct + '%"></span></div></div>';
    }).join("");
  }

  var top = publicPosts.slice(0, 4);
  var rows = publicPosts.slice(0, 4).map(function (post) {
    return '<tr><td><b>' + esc(post.title) + '</b></td><td>' + esc(post.type) + '</td><td>' + Number(post.likes || 0) + '</td></tr>';
  }).join("") || '<tr><td colspan="3" class="empty">No likes yet.</td></tr>';
  var topTable = document.getElementById("analyticsTopPosts");
  if (topTable) topTable.innerHTML = rows;
}

/* ---------- calendar ---------- */
function buildCalendar() {
  $$("[data-calendar]").forEach(function (wrap) { buildCalendarInto(wrap); });
  buildLoginCalendar();
}

function buildLoginCalendar() {
  var wrap = $("#loginCalendarMonths");
  if (!wrap) return;
  var months = [new Date(calendarNow.getFullYear(), calendarNow.getMonth(), 1), new Date(calendarNow.getFullYear(), calendarNow.getMonth() + 1, 1)];
  wrap.innerHTML = months.map(function (month) {
    var year = month.getFullYear();
    var monthIndex = month.getMonth();
    var days = new Date(year, monthIndex + 1, 0).getDate();
    var firstDay = new Date(year, monthIndex, 1).getDay();
    var events = {};
    posts.filter(isCalendarEvent).forEach(function (p) {
      var date = postDate(p);
      if (date && date.getFullYear() === year && date.getMonth() === monthIndex) (events[date.getDate()] || (events[date.getDate()] = [])).push(p);
    });
    var cells = "";
    for (var i = 0; i < firstDay; i++) cells += '<div class="cal-cell dim"></div>';
    for (var day = 1; day <= days; day++) {
      var dayEvents = events[day] || [];
      cells += '<div class="cal-cell"><div class="d">' + day + "</div>" +
        dayEvents.map(function (event) { return '<div class="cal-ev ' + (event.status === "scheduled" ? "blue" : "") + '">' + esc(event.title) + "</div>"; }).join("") +
        "</div>";
    }
    return '<section class="login-calendar-month"><h4>' + MONTHS[monthIndex] + " " + year + '</h4>' +
      '<div class="cal-head"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>' +
      '<div class="cal-grid">' + cells + "</div></section>";
  }).join("");
}

function calendarDateValue(date) {
  return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
}

function calendarEventDate(p) {
  var date = postDate(p);
  return date ? calendarDateValue(date) : "";
}

function calendarPrettyDate(date) {
  return String(date.getDate()).padStart(2, "0") + " " + MONTHS[date.getMonth()] + " " + date.getFullYear();
}

function buildCalendarInto(wrap) {
  var months = [new Date(calendarNow.getFullYear(), calendarNow.getMonth(), 1), new Date(calendarNow.getFullYear(), calendarNow.getMonth() + 1, 1)];
  var canEdit = false;
  wrap.innerHTML = '<div class="section-title"><h3>Shared Content Calendar</h3><span class="badge scheduled">This month + next month</span></div>' +
    '<div class="calendar-months dashboard-calendar-months">' + months.map(function (month) { return renderDashboardMonth(month, canEdit); }).join("") + "</div>" +
    '<p class="calendar-help">Events are managed through the approval workflow. This view shows the current month and the upcoming month.</p>';
}

function renderDashboardMonth(month, canEdit) {
  var year = month.getFullYear();
  var monthIndex = month.getMonth();
  var days = new Date(year, monthIndex + 1, 0).getDate();
  var firstDay = new Date(year, monthIndex, 1).getDay();
  var events = {};
  posts.filter(isCalendarEvent).forEach(function (p) {
    var date = postDate(p);
    if (date && date.getFullYear() === year && date.getMonth() === monthIndex) (events[date.getDate()] || (events[date.getDate()] = [])).push(p);
  });
  var cells = "";
  for (var i = 0; i < firstDay; i++) cells += '<div class="cal-cell dim"></div>';
  for (var day = 1; day <= days; day++) {
    var dayEvents = events[day] || [];
    var event = dayEvents[0];
    var dateValue = calendarDateValue(new Date(year, monthIndex, day));
    cells += '<div class="cal-cell calendar-day' + (event ? " has-event" : "") + '">' +
      '<span class="d">' + day + "</span>" +
      dayEvents.map(function (item) { return '<span class="cal-ev ' + (item.status === "scheduled" ? "blue" : item.status === "pending" ? "gold" : "") + '">' + esc(item.title) + "</span>"; }).join("") + "</div>";
  }
  return '<section class="dashboard-calendar-month"><h4>' + MONTHS[monthIndex] + " " + year + '</h4>' +
    '<div class="cal-head"><div>Sun</div><div>Mon</div><div>Tue</div><div>Wed</div><div>Thu</div><div>Fri</div><div>Sat</div></div>' +
    '<div class="cal-grid">' + cells + "</div></section>";
}

/* ---------- init ---------- */
document.addEventListener("DOMContentLoaded", function () {
  function applyLandingLayoutOverride() {
    var page = $("#screen-login .login-page");
    var panels = $$("#screen-login .events-panel, #screen-login .landing-templates");
    var cards = $$("#screen-login .event-poster");
    if (page) page.style.borderTop = "1px solid #dde5ee";
    panels.forEach(function (el) {
      el.style.border = "0";
      el.style.boxShadow = "none";
      el.style.background = "transparent";
    });
    cards.forEach(function (el) {
      el.style.border = "0";
      el.style.borderRadius = "0";
      el.style.boxShadow = "none";
      el.style.background = "#ffffff";
      var top = el.querySelector(".poster-top");
      if (top) top.style.borderBottom = "0";
    });
  }

  (async function initializeCalendarDate() {
    await loadCalendarWindow();
    buildCalendar();
    renderLoginEvents();
  }());
  applyLandingLayoutOverride();
  $("#loginTrigger").addEventListener("click", function () {
    var fields = $("#loginFields");
    var isOpen = fields.hidden;
    fields.hidden = !isOpen;
    $("#loginForm").classList.toggle("open", isOpen);
    $("#loginPage").classList.toggle("login-open", isOpen);
    $("#screen-login").classList.toggle("login-open", isOpen);
    $("#screen-login").classList.remove("calendar-open");
    $("#screen-login").style.background = isOpen ? "#ffffff" : "";
    $("#screen-login").style.backgroundImage = isOpen ? "none" : "";
    $("#loginPage").classList.remove("calendar-open");
    $("#loginCalendar").hidden = true;
    $("#calendarTrigger").setAttribute("aria-expanded", "false");
    $("#loginTrigger").setAttribute("aria-expanded", String(isOpen));
    if (isOpen) $("#loginId").focus();
  });
  $("#calendarTrigger").addEventListener("click", function () {
    var calendar = $("#loginCalendar");
    var isOpen = calendar.hidden;
    calendar.hidden = !isOpen;
    $("#loginPage").classList.toggle("calendar-open", isOpen);
    $("#screen-login").classList.toggle("calendar-open", isOpen);
    $("#screen-login").classList.remove("login-open");
    $("#screen-login").style.background = isOpen ? "#ffffff" : "";
    $("#screen-login").style.backgroundImage = isOpen ? "none" : "";
    $("#loginPage").classList.remove("login-open");
    $("#loginFields").hidden = true;
    $("#loginForm").classList.remove("open");
    $("#loginTrigger").setAttribute("aria-expanded", "false");
    $("#calendarTrigger").setAttribute("aria-expanded", String(isOpen));
  });
  $("#calendarClose").addEventListener("click", function () {
    $("#loginCalendar").hidden = true;
    $("#loginPage").classList.remove("calendar-open");
    $("#screen-login").classList.remove("calendar-open");
    $("#screen-login").style.background = "";
    $("#screen-login").style.backgroundImage = "";
    $("#calendarTrigger").setAttribute("aria-expanded", "false");
  });
  $("#loginForm").addEventListener("submit", doLogin);
  $("#registerTrigger").addEventListener("click", openRegistration);
  $("#registerClose").addEventListener("click", closeRegistration);
  $("#registerForm").addEventListener("submit", registerGeneral);
  $("#connectGoogleCalendarButton").addEventListener("click", connectGoogleCalendar);
  $("#disconnectGoogleCalendarButton").addEventListener("click", disconnectGoogleCalendar);
  renderGoogleCalendarStatus();
  var googleCalendarResult = new URLSearchParams(window.location.search).get("googleCalendar");
  if (googleCalendarResult === "connected") toast("Google Calendar connected. Registered events will be added to your personal calendar.");
  if (googleCalendarResult === "error") toast(new URLSearchParams(window.location.search).get("message") || "Google Calendar connection failed.");
  restoreStoredLogin();
  $("#scannerScanButton").addEventListener("click", scanEventPoster);
  $("#openRegistrationFormButton").addEventListener("click", openRegistrationForm);
  $("#registrationCompleteButton").addEventListener("click", completeEventRegistration);
  $("#scannerFile").addEventListener("change", function () {
    if (this.files[0]) $("#scannerStatus").textContent = "Poster selected. Click SCAN QR CODE to continue.";
  });
  $("#createForm").addEventListener("submit", function (e) { submitPost(e, "submit"); });
  $("#checkSimilarityButton").addEventListener("click", checkSimilarity);
  $("#generateCaptionButton").addEventListener("click", generateAICaption);
  $("#generateDescriptionButton").addEventListener("click", generateAIDescription);
  $("#userForm").addEventListener("submit", createUser);
  setInterval(function () {
    buildCalendar();
    renderLoginEvents();
    if (currentRole && ["faculty", "coordinator", "admin"].includes(currentRole)) {
      loadWorkflowPosts().then(render);
    }
    if (currentUser) {
      loadNotifications().then(render);
    }
  }, 30 * 1000);
  ["userSearch"].forEach(function (id) { $("#" + id).addEventListener("input", renderUsers); });
  $("#postSearch").addEventListener("input", renderAllPosts);
  $("#postFilter").addEventListener("change", renderAllPosts);
});
