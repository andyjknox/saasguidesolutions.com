const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); 

app.post('/submit-audit', (req, res) => {
    const { name, email, company, pain_point } = req.body;
    const data = `${new Date().toISOString()} | ${name} | ${email} | ${company} | ${pain_point}\n`;
    
    // Appends to a flat file in the root
    fs.appendFileSync('leads.txt', data);
    res.send('Audit request received. We will contact you shortly.');
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
