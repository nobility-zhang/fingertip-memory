import { createApp } from 'vue';
import App from './app/App.vue';
import './styles/main.css';
import './styles/quest-theme.css';
import { localRepository } from './storage/localRepository';

createApp(App, { repository: localRepository }).mount('#app');
