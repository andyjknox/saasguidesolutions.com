const express = require('express');
const { Resend } = require('resend');
const path = require('path');

const app = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

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

// Booking Consultation Form
app.use(express.json());
app.post('/submit-booking', async (req, res) => {
    const { name, email, company, notes, date, time, duration } = req.body;

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

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safeCompany = escapeHtml(company);
    const safeNotes = escapeHtml(notes);
    const safeDate = escapeHtml(date);
    const safeTime = escapeHtml(time);
    const safeDuration = escapeHtml(String(duration));

    try {
        // Send notification to Andy
        await resend.emails.send({
            from: 'Bookings <andyknox@saasguidesolutions.com>',
            to: 'andyknox@saasguidesolutions.com',
            subject: `New Consultation Booking: ${safeName} - ${safeDate} at ${safeTime}`,
            html: `
                <div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                    <h2 style="color: #2563eb;">New Consultation Booked</h2>
                    <div style="background: #eff6ff; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
                        <p style="margin: 0; font-size: 18px; font-weight: bold;">${safeDate} at ${safeTime}</p>
                        <p style="margin: 5px 0 0; color: #666;">${safeDuration} minute consultation</p>
                    </div>
                    <p><strong>Name:</strong> ${safeName}</p>
                    <p><strong>Email:</strong> ${safeEmail}</p>
                    <p><strong>Company:</strong> ${safeCompany || '<em>Not provided</em>'}</p>
                    <p><strong>Discussion Topic:</strong> ${safeNotes || '<em>Not provided</em>'}</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
                    <p style="color: #999; font-size: 12px;">Remember to send a calendar invite to ${safeEmail}</p>
                </div>
            `
        });

        // Send confirmation to the booker
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
                        <p style="margin: 5px 0 0; color: #666;">${safeDuration} minute video call</p>
                    </div>
                    <p>You'll receive a calendar invite with the video call link shortly.</p>
                    <p>If you need to reschedule, simply reply to this email.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 15px 0;">
                    <p style="color: #999; font-size: 12px;">SaaS Guide Solutions | andyknox@saasguidesolutions.com</p>
                </div>
            `
        });

        res.json({ success: true });
    } catch (error) {
        console.error("Resend Error (Booking):", error);
        res.status(500).json({ error: 'Failed to send confirmation' });
    }
});

app.listen(PORT, () => console.log(`Server active on port ${PORT}`));
