# Custom Shapes Bot Creator
This hunk of stuff allows you to create your own shapes bot if you want idk


## INSTRUCTIONS

Prerequisites: NodeJS and an account on https://talk.shapes.inc/
1. Donwload the Zip and extract to a folder. Preferrably make sure it isn't a subfolder of a folder with the same name to avoid confusion (e.g Downloads/custom-bot/custom-bot)
2. Make sure you have NodeJs installed if you haven't already, must be above v18
3. Rename env.example to .env and edit it with all required variables in your IDE
4. Open your command prompt or IDE terminal. Make sure your file path is on your bot folder. (cd [FILE_PATH] on command prompt). Once you are in the correct path, run `npm install puppeteer better-sqlite3 dotenv discord.js`
5. Once those modules are installed and your env has all required variables such as yout token and shape slug, run `node index.js` (make sure you are in the folder)
6. MAKE SURE YOU CREATE A talk.shapes.inc ACCOUNT IF YOU DON'T HAVE ONE ALREADY. On the first time you launch you will be asked to log in on the Puppeteer browser. Log in and then close your terminal. Reopen your terminal and run `node index.js` once again and you should be automatically logged in. Note that the browser will be headless but if you have done everything correctly your console should show that your bot has gone online.

**Disclaimer**: Logging in will generate a cookies json afterwards on your folder. This is used to log in automatically on launch. I DO NOT AND WILL NEVER HAVE YOUR COOKIES OR ACCOUNT. You can inspect index.js yourself at any time.

### Your Discord shape bot should now be running and ready to chat as a shape!
