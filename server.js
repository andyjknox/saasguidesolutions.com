const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// Email Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail', // or your email provider
    auth: {
        user: 'andyknox@saasguidesolutions.com',
        pass: 'tzkncvwqnmicefkj' // Set this in Railway Variables
    }
});

app.post('/submit-audit', (req, res) => {
    const { name, email, company, bottleneck } = req.body;

    const mailOptions = {
        from: 'andyknox@saasguidesolutions.com',
        to: 'andyknox@saasguidesolutions.com',
        subject: `New GTM Audit Request: ${company}`,
        text: `Name: ${name}\nEmail: ${email}\nCompany: ${company}\nBottleneck: ${bottleneck}`
    };

    transporter.sendMail(mailOptions, (error, info) => {
        if (error) {
            console.log(error);
            res.status(500).send('Error sending email');
        } else {
            // Redirect to a success page or send a message
            res.send('<h1>Submission Successful</h1><p>Andy will contact you shortly.</p><a href="/">Back to Home</a>');
        }
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
