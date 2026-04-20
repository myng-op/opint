I have made my plan here in a very naive manner, as I don't know how to define things precisely, so please let me know if you have any suggestions or improvements. We are going to build an AI social worker interview system using:
- Azure gpt-realtime-1.5 for real-time transcription and speech interaction
- MongoDB for storing interview data
- React and Node.js for the web dev framework
- JavaScript for the core programming languages
- npm for project management and environment setup
- docker for containerization and deployment 
- git for version control and collaboration
- GitHub for code hosting and project management
  
My project goal: This interview system acts like social workers. The human will prepare and give the set of questions, and the AI will conduct the interview, transcribe it, and store the data. 
- The system is shown to the interviewee as a web application, where they will interact with the AI in real-time. The AI has please and empathy built into its responses, making the interview process more comfortable for the interviewee. To make it less intimidating, the AI will have a friendly avatar. The user can choose to hide or show the transcript on the screen. 
- The system access to the question one by one through Tool Calling to make sure that the AI only moves on to the next question when it is satisfied with the answer to the current question. (will this allow a more natural flow of conversation and ensures that the AI is fully engaged in the interview process), while not overwhelming the AI with the entire list of questions at once.
- Design the database schema to efficiently store interview data, including questions, answers, timestamps, and any relevant metadata. This will allow for easy retrieval and analysis of interview data in the future.
- Design the system to be modular and scalable, allowing for easy updates and the addition of new features in the future. For example, we can easily integrate additional AI models or expand the database schema to accommodate more complex interview data.