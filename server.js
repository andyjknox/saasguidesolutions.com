require('dotenv').config();
const express = require('express');
const { Resend } = require('resend');
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(__dirname));

// ==================== Google Calendar OAuth ====================
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/auth/google/callback`;
const TOKEN_PATH = process.env.GOOGLE_TOKEN_JSON
    ? null // Use env var in production
    : path.join(__dirname, 'google-token.json');
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

const oauth2Client = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
);

// Load saved token
function loadToken() {
    // First check env var (for Railway)
    if (process.env.GOOGLE_TOKEN_JSON) {
        try {
            const tokens = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
            oauth2Client.setCredentials(tokens);
            return true;
        } catch (e) {
            console.error('Failed to parse GOOGLE_TOKEN_JSON env var:', e);
            return false;
        }
    }
    // Then check file (for local dev)
    if (TOKEN_PATH && fs.existsSync(TOKEN_PATH)) {
        try {
            const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
            oauth2Client.setCredentials(tokens);
            return true;
        } catch (e) {
            console.error('Failed to load token file:', e);
            return false;
        }
    }
    return false;
}

let calendarConnected = loadToken();

// OAuth: Step 1 - Redirect to Google
app.get('/auth/google', (req, res) => {
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        prompt: 'consent',
        scope: ['https://www.googleapis.com/auth/calendar'],
    });
    res.redirect(authUrl);
});

// OAuth: Step 2 - Handle callback
app.get('/auth/google/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Google OAuth error: ${error}`);
    if (!code) return res.status(400).send('Missing authorization code. Please start the flow at <a href="/auth/google">/auth/google</a>');

    try {
        const { tokens } = await oauth2Client.getToken(code);
        oauth2Client.setCredentials(tokens);
        calendarConnected = true;

        // Save token locally for dev
        if (TOKEN_PATH) {
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        }

        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #16a34a;">Calendar Connected!</h1>
                <p>Google Calendar is now linked to your booking page.</p>
                <p style="color: #666; font-size: 14px; margin-top: 20px;">
                    <strong>For Railway:</strong> Copy this token JSON and set it as the <code>GOOGLE_TOKEN_JSON</code> environment variable:
                </p>
                <textarea style="width: 100%; max-width: 600px; height: 120px; margin-top: 10px; font-family: monospace; font-size: 11px; padding: 10px; border: 1px solid #ddd; border-radius: 8px;">${JSON.stringify(tokens)}</textarea>
                <br><br>
                <a href="/" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Home</a>
            </div>
        `);
    } catch (error) {
        console.error('OAuth callback error:', error);
        res.status(500).send('Failed to authorize. Please try again.');
    }
});

// API: Check calendar availability for a given date
app.get('/api/availability', async (req, res) => {
    if (!calendarConnected) {
        // If calendar not connected, return all default slots as available
        return res.json({ slots: getDefaultSlots() });
    }

    const { date } = req.query; // Format: YYYY-MM-DD
    if (!date) return res.status(400).json({ error: 'Date required' });

    try {
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        const startOfDay = new Date(date + 'T00:00:00-07:00'); // PT
        const endOfDay = new Date(date + 'T23:59:59-07:00');

        const events = await calendar.events.list({
            calendarId: CALENDAR_ID,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
        });

        const busySlots = (events.data.items || []).map(event => ({
            start: new Date(event.start.dateTime || event.start.date),
            end: new Date(event.end.dateTime || event.end.date),
        }));

        // Filter out busy times from available slots
        const allSlots = getDefaultSlots();
        const available = allSlots.filter(slot => {
            const slotStart = parseSlotTime(date, slot);
            const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000);
            return !busySlots.some(busy =>
                slotStart < busy.end && slotEnd > busy.start
            );
        });

        res.json({ slots: available });
    } catch (error) {
        console.error('Calendar availability error:', error);
        // Fallback to all slots if calendar errors
        res.json({ slots: getDefaultSlots() });
    }
});

// API: Calendar connection status
app.get('/api/calendar-status', (req, res) => {
    res.json({ connected: calendarConnected });
});

function getDefaultSlots() {
    return [
        '9:00 AM', '9:30 AM', '10:00 AM', '10:30 AM',
        '11:00 AM', '11:30 AM', '12:00 PM', '12:30 PM',
        '1:00 PM', '1:30 PM', '2:00 PM', '2:30 PM',
        '3:00 PM', '3:30 PM', '4:00 PM', '4:30 PM'
    ];
}

function parseSlotTime(dateStr, timeStr) {
    const [time, period] = timeStr.split(' ');
    let [hours, minutes] = time.split(':').map(Number);
    if (period === 'PM' && hours !== 12) hours += 12;
    if (period === 'AM' && hours === 12) hours = 0;
    return new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00-07:00`);
}

// Simple in-memory rate limiter (per IP, 3 submissions per 15 minutes)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 3;

function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry) {
        rateLimitMap.set(ip, { count: 1, windowStart: now });
        return false;
    }
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(ip, { count: 1, windowStart: now });
        return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT_MAX;
}

// Blocked personal email domains
const blockedDomains = [
    'gmail.com','googlemail.com','yahoo.com','yahoo.co.uk','yahoo.ca',
    'hotmail.com','hotmail.co.uk','outlook.com','live.com','msn.com',
    'aol.com','icloud.com','me.com','mac.com','mail.com','protonmail.com',
    'proton.me','zoho.com','yandex.com','gmx.com','gmx.net',
    'fastmail.com','tutanota.com','hey.com','inbox.com','rediffmail.com',
    'qq.com','163.com','126.com','sina.com','comcast.net','verizon.net',
    'att.net','sbcglobal.net','bellsouth.net','cox.net','charter.net',
    'earthlink.net','optonline.net','rocketmail.com','ymail.com'
];

// Escape HTML to prevent XSS in email templates and responses
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

app.post('/submit-audit', async (req, res) => {
    const { name, email, company, bottleneck, website_url, _formRenderedAt } = req.body;

    // Honeypot check - if filled, it's a bot
    if (website_url) {
        // Silently accept to not tip off the bot, but don't send email
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Submission Received!</h1>
                <p>Thanks, we'll be in touch shortly.</p>
                <a href="/" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Home</a>
            </div>
        `);
    }

    // Timestamp check - form must take at least 3 seconds to fill
    if (_formRenderedAt) {
        const elapsed = Date.now() - parseInt(_formRenderedAt, 10);
        if (elapsed < 3000) {
            return res.send(`
                <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>Submission Received!</h1>
                    <p>Thanks, we'll be in touch shortly.</p>
                    <a href="/" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Home</a>
                </div>
            `);
        }
    }

    // Rate limiting
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
        return res.status(429).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Too Many Requests</h1>
                <p>Please wait a few minutes before submitting again.</p>
                <a href="/" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Home</a>
            </div>
        `);
    }

    // Validate required fields
    if (!name || !email || !company) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Missing Required Fields</h1>
                <p>Please fill in your name, work email, and company URL.</p>
                <a href="/#audit" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Invalid Email</h1>
                <p>Please provide a valid email address.</p>
                <a href="/#audit" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    // Block personal email domains
    const emailDomain = email.trim().toLowerCase().split('@')[1];
    if (blockedDomains.includes(emailDomain)) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Work Email Required</h1>
                <p>Please use your company email address. Personal email addresses (Gmail, Hotmail, etc.) are not accepted.</p>
                <a href="/#audit" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    // Sanitize all inputs for use in HTML email
    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeCompany = escapeHtml(company);
    const safeBottleneck = escapeHtml(bottleneck);

    try {
        const data = await resend.emails.send({
            from: 'GTM Audit <andyknox@saasguidesolutions.com>',
            to: 'andyknox@saasguidesolutions.com',
            subject: `New GTM Audit Request: ${safeCompany}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #333;">New Lead Received</h2>
                    <p><strong>Name:</strong> ${safeName}</p>
                    <p><strong>Email:</strong> ${safeEmail}</p>
                    <p><strong>Company:</strong> ${safeCompany}</p>
                    <p><strong>Bottleneck:</strong> ${safeBottleneck}</p>
                </div>
            `
        });

        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Submission Received!</h1>
                <p>Thanks ${safeName}, someone from our team will be in touch shortly.</p>
                <a href="/" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Home</a>
            </div>
        `);
    } catch (error) {
        console.error("Resend Error Details:", error);
        res.status(500).send("Error sending email. Please contact Andy directly at andyknox@saasguidesolutions.com");
    }
});

// SpeedySheets Free Trial Form
app.post('/submit-speedysheets', async (req, res) => {
    const { name, email, is_contractor, industry, hates_timesheets, website_url, _formRenderedAt } = req.body;

    // Honeypot check
    if (website_url) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Request Received!</h1>
                <p>Thanks, someone from our team will be in touch shortly.</p>
                <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
            </div>
        `);
    }

    // Timestamp check
    if (_formRenderedAt) {
        const elapsed = Date.now() - parseInt(_formRenderedAt, 10);
        if (elapsed < 3000) {
            return res.send(`
                <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>Request Received!</h1>
                    <p>Thanks, someone from our team will be in touch shortly.</p>
                    <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
                </div>
            `);
        }
    }

    // Rate limiting
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
        return res.status(429).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Too Many Requests</h1>
                <p>Please wait a few minutes before submitting again.</p>
                <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
            </div>
        `);
    }

    // Validate required fields
    if (!name || !email || !is_contractor || !industry) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Missing Required Fields</h1>
                <p>Please fill in all required fields.</p>
                <a href="/solutions.html#speedysheets-trial" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Invalid Email</h1>
                <p>Please provide a valid email address.</p>
                <a href="/solutions.html#speedysheets-trial" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    // Block personal email domains
    const emailDomain = email.trim().toLowerCase().split('@')[1];
    if (blockedDomains.includes(emailDomain)) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Work Email Required</h1>
                <p>Please use your company email address. Personal email addresses (Gmail, Hotmail, etc.) are not accepted.</p>
                <a href="/solutions.html#speedysheets-trial" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeContractor = escapeHtml(is_contractor);
    const safeIndustry = escapeHtml(industry);
    const safeHate = escapeHtml(hates_timesheets);

    try {
        await resend.emails.send({
            from: 'SpeedySheets <andyknox@saasguidesolutions.com>',
            to: 'andyknox@saasguidesolutions.com',
            subject: `SpeedySheets Free Trial Request: ${safeName}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #16a34a;">SpeedySheets Trial Request</h2>
                    <p><strong>Name:</strong> ${safeName}</p>
                    <p><strong>Email:</strong> ${safeEmail}</p>
                    <p><strong>Contractor:</strong> ${safeContractor}</p>
                    <p><strong>Industry:</strong> ${safeIndustry}</p>
                    <p><strong>Hates Timesheets:</strong> ${safeHate}/10</p>
                </div>
            `
        });

        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1 style="color: #16a34a;">You're In!</h1>
                <p>Thanks ${safeName}, someone from our team will get you set up with your free SpeedySheets licence shortly.</p>
                <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
            </div>
        `);
    } catch (error) {
        console.error("Resend Error (SpeedySheets):", error);
        res.status(500).send("Error sending request. Please contact andyknox@saasguidesolutions.com directly.");
    }
});

// Whistler Intel Interest Form
app.post('/submit-whistler', async (req, res) => {
    const { name, email, interest_type, message, website_url, _formRenderedAt } = req.body;

    // Honeypot check
    if (website_url) {
        return res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Thanks for Your Interest!</h1>
                <p>We'll be in touch.</p>
                <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
            </div>
        `);
    }

    // Timestamp check
    if (_formRenderedAt) {
        const elapsed = Date.now() - parseInt(_formRenderedAt, 10);
        if (elapsed < 3000) {
            return res.send(`
                <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>Thanks for Your Interest!</h1>
                    <p>We'll be in touch.</p>
                    <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
                </div>
            `);
        }
    }

    // Rate limiting
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
        return res.status(429).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Too Many Requests</h1>
                <p>Please wait a few minutes before submitting again.</p>
                <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
            </div>
        `);
    }

    // Validate required fields
    if (!name || !email || !interest_type) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Missing Required Fields</h1>
                <p>Please fill in your name, email, and interest type.</p>
                <a href="/solutions.html#whistler-intel" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Invalid Email</h1>
                <p>Please provide a valid email address.</p>
                <a href="/solutions.html#whistler-intel" style="color: #2563eb; text-decoration: none; font-weight: bold;">Go Back</a>
            </div>
        `);
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeInterest = escapeHtml(interest_type);
    const safeMessage = escapeHtml(message);

    try {
        await resend.emails.send({
            from: 'Whistler Intel <andyknox@saasguidesolutions.com>',
            to: 'andyknox@saasguidesolutions.com',
            subject: `Whistler Intel Interest: ${safeInterest} - ${safeName}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #0f172a;">Whistler Intel Interest</h2>
                    <p><strong>Name:</strong> ${safeName}</p>
                    <p><strong>Email:</strong> ${safeEmail}</p>
                    <p><strong>Interest:</strong> ${safeInterest}</p>
                    <p><strong>Message:</strong> ${safeMessage || '<em>None provided</em>'}</p>
                </div>
            `
        });

        res.send(`
            <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                <h1>Thanks for Your Interest!</h1>
                <p>${safeName}, someone from our team will reach out to discuss Whistler Intel with you.</p>
                <a href="/solutions.html" style="color: #2563eb; text-decoration: none; font-weight: bold;">Back to Solutions</a>
            </div>
        `);
    } catch (error) {
        console.error("Resend Error (Whistler Intel):", error);
        res.status(500).send("Error sending request. Please contact andyknox@saasguidesolutions.com directly.");
    }
});

// Duplicate booking prevention (by email + IP)
const bookingTracker = new Map();
const BOOKING_COOLDOWN = 7 * 24 * 60 * 60 * 1000; // 7 days

function hasExistingBooking(email, ip) {
    const now = Date.now();
    // Check by email
    const emailKey = 'email:' + email.trim().toLowerCase();
    const emailEntry = bookingTracker.get(emailKey);
    if (emailEntry && (now - emailEntry) < BOOKING_COOLDOWN) return true;
    // Check by IP
    const ipKey = 'ip:' + ip;
    const ipEntry = bookingTracker.get(ipKey);
    if (ipEntry && (now - ipEntry) < BOOKING_COOLDOWN) return true;
    return false;
}

function trackBooking(email, ip) {
    const now = Date.now();
    bookingTracker.set('email:' + email.trim().toLowerCase(), now);
    bookingTracker.set('ip:' + ip, now);
}

// Booking Consultation Form
app.post('/submit-booking', async (req, res) => {
    const { name, email, company, notes, date, time, duration, isoDate, meetingType, phone } = req.body;

    // Rate limiting
    const clientIp = req.ip || req.connection.remoteAddress;
    if (isRateLimited(clientIp)) {
        return res.status(429).json({ error: 'Too many requests' });
    }

    // Validate required fields
    if (!name || !email || !date || !time || !duration) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ error: 'Invalid email' });
    }

    // Validate phone if phone call selected
    if (meetingType === 'phone' && (!phone || !/^[\d\s\-\(\)\+\.]{7,20}$/.test(phone))) {
        return res.status(400).json({ error: 'Valid phone number required for phone calls' });
    }

    // Duplicate booking prevention
    if (hasExistingBooking(email, clientIp)) {
        return res.status(409).json({ error: 'You have already booked a meeting. You cannot book multiple meetings. Please contact andyknox@saasguidesolutions.com to reschedule.' });
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeCompany = escapeHtml(company);
    const safeNotes = escapeHtml(notes);
    const safeDate = escapeHtml(date);
    const safeTime = escapeHtml(time);
    const safeDuration = escapeHtml(String(duration));
    const safePhone = escapeHtml(phone);
    const safeMeetingType = meetingType === 'phone' ? 'Phone Call' : 'Video Call';

    // Create Google Calendar event if connected
    let calendarEventCreated = false;
    if (calendarConnected && isoDate) {
        try {
            const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
            const startTime = parseSlotTime(isoDate, time);
            const endTime = new Date(startTime.getTime() + parseInt(duration) * 60 * 1000);

            const eventBody = {
                summary: `Consultation: ${name}${company ? ' (' + company + ')' : ''} [${safeMeetingType}]`,
                description: `Booked via saasguidesolutions.com\n\nName: ${name}\nEmail: ${email}\nCompany: ${company || 'N/A'}\nType: ${safeMeetingType}${meetingType === 'phone' ? '\nPhone: ' + phone : ''}\nTopic: ${notes || 'N/A'}`,
                start: { dateTime: startTime.toISOString(), timeZone: 'America/Los_Angeles' },
                end: { dateTime: endTime.toISOString(), timeZone: 'America/Los_Angeles' },
                attendees: [
                    { email: email, displayName: name },
                ],
                reminders: { useDefault: true },
            };

            // Only add Google Meet for video calls
            if (meetingType !== 'phone') {
                eventBody.conferenceData = {
                    createRequest: { requestId: Date.now().toString() }
                };
            }

            await calendar.events.insert({
                calendarId: CALENDAR_ID,
                requestBody: eventBody,
                conferenceDataVersion: meetingType !== 'phone' ? 1 : 0,
                sendUpdates: 'all',
            });
            calendarEventCreated = true;
        } catch (error) {
            console.error('Calendar event creation error:', error);
            // Continue with email notification even if calendar fails
        }
    }

    try {
        const calNote = calendarEventCreated
            ? '<p style="color: #16a34a; font-weight: bold;">Calendar event created automatically with invite sent.</p>'
            : '<p style="color: #999; font-size: 12px;">Calendar not connected - remember to send a calendar invite to ' + safeEmail + '</p>';

        // Send notification to Andy
        await resend.emails.send({
            from: 'Bookings <andyknox@saasguidesolutions.com>',
            to: 'andyknox@saasguidesolutions.com',
            subject: `New Consultation Booking: ${safeName} - ${safeDate} at ${safeTime} [${safeMeetingType}]`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #2563eb;">New Consultation Booked</h2>
                    <div style="background: #eff6ff; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <p style="margin: 0; font-size: 18px; font-weight: bold;">${safeDate} at ${safeTime}</p>
                        <p style="margin: 5px 0 0; color: #666;">${safeDuration} minute ${safeMeetingType.toLowerCase()}</p>
                    </div>
                    <p><strong>Name:</strong> ${safeName}</p>
                    <p><strong>Email:</strong> ${safeEmail}</p>
                    ${meetingType === 'phone' ? '<p><strong>Phone:</strong> ' + safePhone + '</p>' : ''}
                    <p><strong>Company:</strong> ${safeCompany || '<em>Not provided</em>'}</p>
                    <p><strong>Discussion Topic:</strong> ${safeNotes || '<em>Not provided</em>'}</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
                    ${calNote}
                </div>
            `
        });

        // Send confirmation to the booker
        let meetingNote;
        if (meetingType === 'phone') {
            meetingNote = '<p>We will call you at <strong>' + safePhone + '</strong> at the scheduled time.</p>';
        } else if (calendarEventCreated) {
            meetingNote = '<p>A calendar invite with a Google Meet link has been sent to your email.</p>';
        } else {
            meetingNote = '<p>You\'ll receive a calendar invite with the video call link shortly.</p>';
        }

        await resend.emails.send({
            from: 'SaaS Guide Solutions <andyknox@saasguidesolutions.com>',
            to: email,
            subject: `Consultation Confirmed: ${safeDate} at ${safeTime}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #2563eb;">Your Consultation is Confirmed</h2>
                    <p>Hi ${safeName},</p>
                    <p>Your consultation with SaaS Guide Solutions has been booked.</p>
                    <div style="background: #eff6ff; padding: 15px; border-radius: 8px; margin: 15px 0;">
                        <p style="margin: 0; font-size: 18px; font-weight: bold;">${safeDate} at ${safeTime} (PT)</p>
                        <p style="margin: 5px 0 0; color: #666;">${safeDuration} minute ${safeMeetingType.toLowerCase()}</p>
                    </div>
                    ${meetingNote}
                    <p>If you need to reschedule, simply reply to this email.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
                    <p style="color: #999; font-size: 12px;">SaaS Guide Solutions | andyknox@saasguidesolutions.com</p>
                </div>
            `
        });

        // Track this booking to prevent duplicates
        trackBooking(email, clientIp);

        res.json({ success: true, calendarEvent: calendarEventCreated });
    } catch (error) {
        console.error("Resend Error (Booking):", error);
        res.status(500).json({ error: 'Failed to send confirmation' });
    }
});

app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
