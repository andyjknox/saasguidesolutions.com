const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const app = express();

// Use 8080 as discussed since your Railway URL preferred it
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Email Configuration pulling from Railway Variables
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
    }
});

app.post('/submit-audit', (req, res) => {
    const { name, email, company, bottleneck } = req.body;

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: 'andyknox@saasguidesolutions.com',
        subject: `New GTM Audit Request: ${company}`,
        text: `Name: ${name}\nEmail: ${email}\nCompany: ${company}\nBottleneck: ${bottleneck}`
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.error('Email Error:', error);
            res.status(500).send('Something went wrong. Please email Andy directly at andyknox@saasguidesolutions.com');
        } else {
            // High-value redirect to your bio page/success message
            res.send(`
                <div style="font-family: sans-serif; text-align: center; padding: 50px;">
                    <h1>Audit Request Received!</h1>
                    <p>Thanks, ${name}. I'll review ${company}'s bottleneck and get back to you.</p>
                    <a href="/" style="color: blue;">Return to Home</a>
                </div>
            `);
        }
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
