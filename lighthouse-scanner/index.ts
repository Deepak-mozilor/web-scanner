import app from './src/server';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.listen(PORT, () => {
  console.log(`Lighthouse scanner running on http://localhost:${PORT}`);
  console.log('POST /scan  { url, strategy?, categories?, timeout? }');
  console.log('GET  /health');
});
