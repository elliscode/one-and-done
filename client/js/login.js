import { $, api, toast } from './common.js';

$('#login').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('POST', '/api/login', { password: $('#password').value });
    const next = new URLSearchParams(location.search).get('next');
    location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dm';
  } catch (err) {
    toast(err.message, 'error');
    $('#password').select();
  }
});
